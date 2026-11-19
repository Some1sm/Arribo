package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// GTFS Realtime data model (absent != zero via pointers or has flags).

type FeedMessage struct {
	Header   FeedHeader
	Entities []Entity
}

type FeedHeader struct {
	GtfsRealtimeVersion string
	Incrementality      int
	Timestamp           uint64
	hasIncrementality   bool
}

type Entity struct {
	ID         string
	IsDeleted  bool
	TripUpdate *TripUpdate
	Vehicle    *VehiclePosition
	Alert      *Alert
}

type TripDescriptor struct {
	TripID                  string
	RouteID                 string
	DirectionID             *uint32
	StartTime               string
	StartDate               string
	ScheduleRelationship    int
	hasScheduleRelationship bool
}

type VehicleDescriptor struct {
	ID, Label, LicensePlate string
	// WheelchairAccessible is field 4 (a newer GTFS-RT addition; Renfe sends it).
	WheelchairAccessible *int
}

type TripUpdate struct {
	Trip            TripDescriptor
	Vehicle         *VehicleDescriptor
	StopTimeUpdates []StopTimeUpdate
	Timestamp       *uint64
	Delay           *int32
}

type StopTimeUpdate struct {
	StopSequence            *uint32
	StopID                  string
	Arrival                 *StopTimeEvent
	Departure               *StopTimeEvent
	ScheduleRelationship    int
	hasScheduleRelationship bool
}

type StopTimeEvent struct {
	Delay       *int32
	Time        *int64
	Uncertainty *int32
}

type VehiclePosition struct {
	Trip                *TripDescriptor
	Vehicle             *VehicleDescriptor
	Position            *Position
	CurrentStopSequence *uint32
	StopID              string
	CurrentStatus       *int
	Timestamp           *uint64
	OccupancyStatus     *int
}

type Position struct {
	Latitude, Longitude float32
	Bearing             *float32
	Odometer            *float64
	Speed               *float32
}

type TimeRange struct {
	Start, End uint64
}

type EntitySelector struct {
	AgencyID, RouteID, StopID string
	RouteType                 *int32
	Trip                      *TripDescriptor
}

type Translation struct {
	Text, Language string
}

type TranslatedString []Translation

type Alert struct {
	ActivePeriods    []TimeRange
	InformedEntities []EntitySelector
	Cause, Effect    int
	URL              TranslatedString
	HeaderText       TranslatedString
	DescriptionText  TranslatedString
	hasCause         bool
	hasEffect        bool
}

// Minimal protobuf wire-format reader. Rejects truncated input and over-long varints.
type pbReader struct {
	b []byte
	i int
}

func (r *pbReader) hasMore() bool { return r.i < len(r.b) }

func (r *pbReader) readVarint() (uint64, error) {
	var val uint64
	var shift uint
	for i := 0; i < 10; i++ {
		if r.i >= len(r.b) {
			return 0, errors.New("truncated varint")
		}
		b := r.b[r.i]
		r.i++
		val |= uint64(b&0x7f) << shift
		if (b & 0x80) == 0 {
			return val, nil
		}
		shift += 7
	}
	return 0, errors.New("over-long varint")
}

func (r *pbReader) readTag() (uint32, int, error) {
	v, err := r.readVarint()
	if err != nil {
		return 0, 0, err
	}
	fn, wt := uint32(v>>3), int(v&0x7)
	if fn == 0 {
		return 0, 0, errors.New("invalid field number 0")
	}
	return fn, wt, nil
}

func (r *pbReader) readBytes() ([]byte, error) {
	n, err := r.readVarint()
	if err != nil {
		return nil, err
	}
	if n > uint64(len(r.b)-r.i) {
		return nil, errors.New("truncated length-delimited field")
	}
	res := r.b[r.i : r.i+int(n)]
	r.i += int(n)
	return res, nil
}

func (r *pbReader) readString() (string, error) {
	b, err := r.readBytes()
	return string(b), err
}

func (r *pbReader) readFloat32() (float32, error) {
	if len(r.b)-r.i < 4 {
		return 0, errors.New("truncated fixed32")
	}
	v := math.Float32frombits(binary.LittleEndian.Uint32(r.b[r.i : r.i+4]))
	r.i += 4
	return v, nil
}

func (r *pbReader) readFloat64() (float64, error) {
	if len(r.b)-r.i < 8 {
		return 0, errors.New("truncated fixed64")
	}
	v := math.Float64frombits(binary.LittleEndian.Uint64(r.b[r.i : r.i+8]))
	r.i += 8
	return v, nil
}

func (r *pbReader) int() (int, error)     { v, err := r.readVarint(); return int(v), err }
func (r *pbReader) u32() (*uint32, error) { v, err := r.readVarint(); u := uint32(v); return &u, err }
func (r *pbReader) u64() (*uint64, error) { v, err := r.readVarint(); return &v, err }
func (r *pbReader) i32() (*int32, error) {
	v, err := r.readVarint()
	i := int32(int64(v))
	return &i, err
}
func (r *pbReader) i64() (*int64, error)   { v, err := r.readVarint(); i := int64(v); return &i, err }
func (r *pbReader) intPtr() (*int, error)  { v, err := r.readVarint(); i := int(v); return &i, err }
func (r *pbReader) f32() (*float32, error) { f, err := r.readFloat32(); return &f, err }
func (r *pbReader) f64() (*float64, error) { d, err := r.readFloat64(); return &d, err }

func (r *pbReader) skip(wt int) error {
	switch wt {
	case 0:
		_, err := r.readVarint()
		return err
	case 1:
		if len(r.b)-r.i < 8 {
			return errors.New("truncated fixed64")
		}
		r.i += 8
		return nil
	case 2:
		_, err := r.readBytes()
		return err
	case 5:
		if len(r.b)-r.i < 4 {
			return errors.New("truncated fixed32")
		}
		r.i += 4
		return nil
	default:
		return fmt.Errorf("unsupported wire type %d", wt)
	}
}

func (r *pbReader) scan(fn func(tag uint32, wt int) error) error {
	for r.hasMore() {
		t, wt, err := r.readTag()
		if err != nil {
			return err
		}
		if err = fn(t, wt); err != nil {
			return err
		}
	}
	return nil
}

func readMsg[T any](r *pbReader, dec func([]byte) (T, error)) (T, error) {
	sub, err := r.readBytes()
	if err != nil {
		var zero T
		return zero, err
	}
	return dec(sub)
}

func readMsgPtr[T any](r *pbReader, dec func([]byte) (T, error)) (*T, error) {
	v, err := readMsg(r, dec)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

// Protobuf message decoders.

func decodeFeedHeader(b []byte) (h FeedHeader, err error) {
	r := &pbReader{b: b}
	return h, r.scan(func(t uint32, wt int) (err error) {
		switch t {
		case 1:
			h.GtfsRealtimeVersion, err = r.readString()
		case 2:
			var v int
			v, err = r.int()
			h.Incrementality, h.hasIncrementality = v, true
		case 3:
			h.Timestamp, err = r.readVarint()
		default:
			err = r.skip(wt)
		}
		return
	})
}

func decodeTripDescriptor(b []byte) (td TripDescriptor, err error) {
	r := &pbReader{b: b}
	return td, r.scan(func(t uint32, wt int) (err error) {
		switch t {
		case 1:
			td.TripID, err = r.readString()
		case 2:
			td.StartTime, err = r.readString()
		case 3:
			td.StartDate, err = r.readString()
		case 4:
			var v int
			v, err = r.int()
			td.ScheduleRelationship, td.hasScheduleRelationship = v, true
		case 5:
			td.RouteID, err = r.readString()
		case 6:
			td.DirectionID, err = r.u32()
		default:
			err = r.skip(wt)
		}
		return
	})
}

func decodeVehicleDescriptor(b []byte) (vd VehicleDescriptor, err error) {
	r := &pbReader{b: b}
	return vd, r.scan(func(t uint32, wt int) (err error) {
		switch t {
		case 1:
			vd.ID, err = r.readString()
		case 2:
			vd.Label, err = r.readString()
		case 3:
			vd.LicensePlate, err = r.readString()
		case 4:
			vd.WheelchairAccessible, err = r.intPtr()
		default:
			err = r.skip(wt)
		}
		return
	})
}

func decodePosition(b []byte) (p Position, err error) {
	r := &pbReader{b: b}
	return p, r.scan(func(t uint32, wt int) (err error) {
		switch t {
		case 1:
			p.Latitude, err = r.readFloat32()
		case 2:
			p.Longitude, err = r.readFloat32()
		case 3:
			p.Bearing, err = r.f32()
		case 4:
			p.Odometer, err = r.f64()
		case 5:
			p.Speed, err = r.f32()
		default:
			err = r.skip(wt)
		}
		return
	})
}

func decodeVehiclePosition(b []byte) (vp VehiclePosition, err error) {
	r := &pbReader{b: b}
	return vp, r.scan(func(t uint32, wt int) (err error) {
		switch t {
		case 1:
			vp.Trip, err = readMsgPtr(r, decodeTripDescriptor)
		case 2:
			vp.Position, err = readMsgPtr(r, decodePosition)
		case 3:
			vp.CurrentStopSequence, err = r.u32()
		case 4:
			vp.CurrentStatus, err = r.intPtr()
		case 5:
			vp.Timestamp, err = r.u64()
		case 6:
			err = r.skip(wt)
		case 7:
			vp.StopID, err = r.readString()
		case 8:
			vp.Vehicle, err = readMsgPtr(r, decodeVehicleDescriptor)
		case 9:
			vp.OccupancyStatus, err = r.intPtr()
		default:
			err = r.skip(wt)
		}
		return
	})
}

func decodeStopTimeEvent(b []byte) (ste StopTimeEvent, err error) {
	r := &pbReader{b: b}
	return ste, r.scan(func(t uint32, wt int) (err error) {
		switch t {
		case 1:
			ste.Delay, err = r.i32()
		case 2:
			ste.Time, err = r.i64()
		case 3:
			ste.Uncertainty, err = r.i32()
		default:
			err = r.skip(wt)
		}
		return
	})
}

func decodeStopTimeUpdate(b []byte) (stu StopTimeUpdate, err error) {
	r := &pbReader{b: b}
	return stu, r.scan(func(t uint32, wt int) (err error) {
		switch t {
		case 1:
			stu.StopSequence, err = r.u32()
		case 2:
			stu.Arrival, err = readMsgPtr(r, decodeStopTimeEvent)
		case 3:
			stu.Departure, err = readMsgPtr(r, decodeStopTimeEvent)
		case 4:
			stu.StopID, err = r.readString()
		case 5:
			var v int
			v, err = r.int()
			stu.ScheduleRelationship, stu.hasScheduleRelationship = v, true
		default:
			err = r.skip(wt)
		}
		return
	})
}

func decodeTripUpdate(b []byte) (tu TripUpdate, err error) {
	r := &pbReader{b: b}
	return tu, r.scan(func(t uint32, wt int) (err error) {
		switch t {
		case 1:
			tu.Trip, err = readMsg(r, decodeTripDescriptor)
		case 2:
			var s StopTimeUpdate
			s, err = readMsg(r, decodeStopTimeUpdate)
			tu.StopTimeUpdates = append(tu.StopTimeUpdates, s)
		case 3:
			tu.Vehicle, err = readMsgPtr(r, decodeVehicleDescriptor)
		case 4:
			tu.Timestamp, err = r.u64()
		case 5:
			tu.Delay, err = r.i32()
		default:
			err = r.skip(wt)
		}
		return
	})
}

func decodeTimeRange(b []byte) (tr TimeRange, err error) {
	r := &pbReader{b: b}
	return tr, r.scan(func(t uint32, wt int) (err error) {
		switch t {
		case 1:
			tr.Start, err = r.readVarint()
		case 2:
			tr.End, err = r.readVarint()
		default:
			err = r.skip(wt)
		}
		return
	})
}

func decodeEntitySelector(b []byte) (es EntitySelector, err error) {
	r := &pbReader{b: b}
	return es, r.scan(func(t uint32, wt int) (err error) {
		switch t {
		case 1:
			es.AgencyID, err = r.readString()
		case 2:
			es.RouteID, err = r.readString()
		case 3:
			es.RouteType, err = r.i32()
		case 4:
			es.Trip, err = readMsgPtr(r, decodeTripDescriptor)
		case 5:
			es.StopID, err = r.readString()
		default:
			err = r.skip(wt)
		}
		return
	})
}

func decodeTranslation(b []byte) (tr Translation, err error) {
	r := &pbReader{b: b}
	return tr, r.scan(func(t uint32, wt int) (err error) {
		switch t {
		case 1:
			tr.Text, err = r.readString()
		case 2:
			tr.Language, err = r.readString()
		default:
			err = r.skip(wt)
		}
		return
	})
}

func decodeTranslatedString(b []byte) (ts TranslatedString, err error) {
	r := &pbReader{b: b}
	return ts, r.scan(func(t uint32, wt int) (err error) {
		if t == 1 {
			var tr Translation
			tr, err = readMsg(r, decodeTranslation)
			ts = append(ts, tr)
		} else {
			err = r.skip(wt)
		}
		return
	})
}

func decodeAlert(b []byte) (a Alert, err error) {
	r := &pbReader{b: b}
	return a, r.scan(func(t uint32, wt int) (err error) {
		switch t {
		case 1:
			var tr TimeRange
			tr, err = readMsg(r, decodeTimeRange)
			a.ActivePeriods = append(a.ActivePeriods, tr)
		case 5:
			var sel EntitySelector
			sel, err = readMsg(r, decodeEntitySelector)
			a.InformedEntities = append(a.InformedEntities, sel)
		case 6:
			var v int
			v, err = r.int()
			a.Cause, a.hasCause = v, true
		case 7:
			var v int
			v, err = r.int()
			a.Effect, a.hasEffect = v, true
		case 8:
			a.URL, err = readMsg(r, decodeTranslatedString)
		case 10:
			a.HeaderText, err = readMsg(r, decodeTranslatedString)
		case 11:
			a.DescriptionText, err = readMsg(r, decodeTranslatedString)
		default:
			err = r.skip(wt)
		}
		return
	})
}

func decodeEntity(b []byte) (e Entity, err error) {
	r := &pbReader{b: b}
	return e, r.scan(func(t uint32, wt int) (err error) {
		switch t {
		case 1:
			e.ID, err = r.readString()
		case 2:
			var v uint64
			v, err = r.readVarint()
			e.IsDeleted = (v != 0)
		case 3:
			e.TripUpdate, err = readMsgPtr(r, decodeTripUpdate)
		case 4:
			e.Vehicle, err = readMsgPtr(r, decodeVehiclePosition)
		case 5:
			e.Alert, err = readMsgPtr(r, decodeAlert)
		default:
			err = r.skip(wt)
		}
		return
	})
}

// decodeGtfsRealtime decodes a FeedMessage protobuf byte slice into Go structs.
func decodeGtfsRealtime(b []byte) (*FeedMessage, error) {
	if len(b) == 0 {
		return &FeedMessage{}, nil
	}
	msg, r := &FeedMessage{}, &pbReader{b: b}
	return msg, r.scan(func(t uint32, wt int) (err error) {
		switch t {
		case 1:
			msg.Header, err = readMsg(r, decodeFeedHeader)
		case 2:
			var ent Entity
			ent, err = readMsg(r, decodeEntity)
			msg.Entities = append(msg.Entities, ent)
		default:
			err = r.skip(wt)
		}
		return
	})
}

// Enum names matching the official GTFS-RT schema.
var (
	incrementalityNames = []string{"FULL_DATASET", "DIFFERENTIAL"}
	tripSchedRelNames   = []string{"SCHEDULED", "ADDED", "UNSCHEDULED", "CANCELED", "REPLACEMENT", "DUPLICATED", "DELETED"}
	stopSchedRelNames   = []string{"SCHEDULED", "SKIPPED", "NO_DATA", "UNSCHEDULED"}
	vehicleStatusNames  = []string{"INCOMING_AT", "STOPPED_AT", "IN_TRANSIT_TO"}
	occupancyNames      = []string{"EMPTY", "MANY_SEATS_AVAILABLE", "FEW_SEATS_AVAILABLE", "STANDING_ROOM_ONLY", "CRUSHED_STANDING_ROOM_ONLY", "FULL", "NOT_ACCEPTING_PASSENGERS", "NO_DATA_AVAILABLE", "NOT_BOARDABLE"}
	causeNames          = []string{"", "UNKNOWN_CAUSE", "OTHER_CAUSE", "TECHNICAL_PROBLEM", "STRIKE", "DEMONSTRATION", "ACCIDENT", "HOLIDAY", "WEATHER", "MAINTENANCE", "CONSTRUCTION", "POLICE_ACTIVITY", "MEDICAL_EMERGENCY", "SPECIAL_EVENT"}
	effectNames         = []string{"", "NO_SERVICE", "REDUCED_SERVICE", "SIGNIFICANT_DELAYS", "DETOUR", "ADDITIONAL_SERVICE", "MODIFIED_SERVICE", "OTHER_EFFECT", "UNKNOWN_EFFECT", "STOP_MOVED", "NO_EFFECT", "ACCESSIBILITY_ISSUE"}
)

func enumName(val int, names []string) string {
	if val >= 0 && val < len(names) && names[val] != "" {
		return names[val]
	}
	return strconv.Itoa(val)
}

// Official GTFS-RT JSON serialization (lowerCamelCase, 64-bit ints as strings, enums as names, absent omitted).

func (m *FeedMessage) MarshalJSON() ([]byte, error) {
	h := map[string]any{}
	setStr(h, "gtfsRealtimeVersion", m.Header.GtfsRealtimeVersion)
	if m.Header.hasIncrementality || m.Header.Incrementality != 0 {
		h["incrementality"] = enumName(m.Header.Incrementality, incrementalityNames)
	}
	if m.Header.Timestamp != 0 {
		h["timestamp"] = strconv.FormatUint(m.Header.Timestamp, 10)
	}
	res := map[string]any{"header": h}
	if len(m.Entities) > 0 {
		ents := make([]any, len(m.Entities))
		for i, e := range m.Entities {
			ents[i] = jsonEntity(e)
		}
		res["entity"] = ents
	}
	return json.Marshal(res)
}

func (e Entity) MarshalJSON() ([]byte, error) { return json.Marshal(jsonEntity(e)) }

func setStr(m map[string]any, k, v string) {
	if v != "" {
		m[k] = v
	}
}

func setPtr[T any](m map[string]any, k string, p *T) {
	if p != nil {
		m[k] = *p
	}
}

func jsonEntity(e Entity) map[string]any {
	m := map[string]any{"id": e.ID}
	if e.IsDeleted {
		m["isDeleted"] = true
	}
	if e.TripUpdate != nil {
		m["tripUpdate"] = jsonTripUpdate(e.TripUpdate)
	}
	if e.Vehicle != nil {
		m["vehicle"] = jsonVehicle(e.Vehicle)
	}
	if e.Alert != nil {
		m["alert"] = jsonAlert(e.Alert)
	}
	return m
}

func jsonTripDesc(td *TripDescriptor) map[string]any {
	m := map[string]any{}
	setStr(m, "tripId", td.TripID)
	setStr(m, "routeId", td.RouteID)
	setPtr(m, "directionId", td.DirectionID)
	setStr(m, "startTime", td.StartTime)
	setStr(m, "startDate", td.StartDate)
	if td.hasScheduleRelationship || td.ScheduleRelationship != 0 {
		m["scheduleRelationship"] = enumName(td.ScheduleRelationship, tripSchedRelNames)
	}
	return m
}

func jsonVehDesc(vd *VehicleDescriptor) map[string]any {
	m := map[string]any{}
	setStr(m, "id", vd.ID)
	setStr(m, "label", vd.Label)
	setStr(m, "licensePlate", vd.LicensePlate)
	if vd.WheelchairAccessible != nil {
		m["wheelchairAccessible"] = enumName(*vd.WheelchairAccessible, wheelchairNames)
	}
	return m
}

func jsonTripUpdate(tu *TripUpdate) map[string]any {
	m := map[string]any{"trip": jsonTripDesc(&tu.Trip)}
	if tu.Vehicle != nil {
		m["vehicle"] = jsonVehDesc(tu.Vehicle)
	}
	if len(tu.StopTimeUpdates) > 0 {
		stus := make([]any, len(tu.StopTimeUpdates))
		for i, s := range tu.StopTimeUpdates {
			stus[i] = jsonStopTimeUpdate(&s)
		}
		m["stopTimeUpdate"] = stus
	}
	if tu.Timestamp != nil {
		m["timestamp"] = strconv.FormatUint(*tu.Timestamp, 10)
	}
	setPtr(m, "delay", tu.Delay)
	return m
}

func jsonStopTimeUpdate(s *StopTimeUpdate) map[string]any {
	m := map[string]any{}
	setPtr(m, "stopSequence", s.StopSequence)
	setStr(m, "stopId", s.StopID)
	if s.Arrival != nil {
		m["arrival"] = jsonStopTimeEvent(s.Arrival)
	}
	if s.Departure != nil {
		m["departure"] = jsonStopTimeEvent(s.Departure)
	}
	if s.hasScheduleRelationship || s.ScheduleRelationship != 0 {
		m["scheduleRelationship"] = enumName(s.ScheduleRelationship, stopSchedRelNames)
	}
	return m
}

func jsonStopTimeEvent(ste *StopTimeEvent) map[string]any {
	m := map[string]any{}
	setPtr(m, "delay", ste.Delay)
	if ste.Time != nil {
		m["time"] = strconv.FormatInt(*ste.Time, 10)
	}
	setPtr(m, "uncertainty", ste.Uncertainty)
	return m
}

func jsonVehicle(vp *VehiclePosition) map[string]any {
	m := map[string]any{}
	if vp.Trip != nil {
		m["trip"] = jsonTripDesc(vp.Trip)
	}
	if vp.Vehicle != nil {
		m["vehicle"] = jsonVehDesc(vp.Vehicle)
	}
	if vp.Position != nil {
		p := map[string]any{"latitude": vp.Position.Latitude, "longitude": vp.Position.Longitude}
		setPtr(p, "bearing", vp.Position.Bearing)
		setPtr(p, "odometer", vp.Position.Odometer)
		setPtr(p, "speed", vp.Position.Speed)
		m["position"] = p
	}
	setPtr(m, "currentStopSequence", vp.CurrentStopSequence)
	setStr(m, "stopId", vp.StopID)
	if vp.CurrentStatus != nil {
		m["currentStatus"] = enumName(*vp.CurrentStatus, vehicleStatusNames)
	}
	if vp.Timestamp != nil {
		m["timestamp"] = strconv.FormatUint(*vp.Timestamp, 10)
	}
	if vp.OccupancyStatus != nil {
		m["occupancyStatus"] = enumName(*vp.OccupancyStatus, occupancyNames)
	}
	return m
}

func jsonAlert(a *Alert) map[string]any {
	m := map[string]any{}
	if len(a.ActivePeriods) > 0 {
		aps := make([]any, len(a.ActivePeriods))
		for i, p := range a.ActivePeriods {
			pm := map[string]any{}
			if p.Start != 0 {
				pm["start"] = strconv.FormatUint(p.Start, 10)
			}
			if p.End != 0 {
				pm["end"] = strconv.FormatUint(p.End, 10)
			}
			aps[i] = pm
		}
		m["activePeriod"] = aps
	}
	if len(a.InformedEntities) > 0 {
		ies := make([]any, len(a.InformedEntities))
		for i, ie := range a.InformedEntities {
			iem := map[string]any{}
			setStr(iem, "agencyId", ie.AgencyID)
			setStr(iem, "routeId", ie.RouteID)
			setPtr(iem, "routeType", ie.RouteType)
			if ie.Trip != nil {
				iem["trip"] = jsonTripDesc(ie.Trip)
			}
			setStr(iem, "stopId", ie.StopID)
			ies[i] = iem
		}
		m["informedEntity"] = ies
	}
	if a.hasCause || a.Cause != 0 {
		m["cause"] = enumName(a.Cause, causeNames)
	}
	if a.hasEffect || a.Effect != 0 {
		m["effect"] = enumName(a.Effect, effectNames)
	}
	for _, pair := range []struct {
		k  string
		ts TranslatedString
	}{{"url", a.URL}, {"headerText", a.HeaderText}, {"descriptionText", a.DescriptionText}} {
		if len(pair.ts) > 0 {
			trList := make([]any, len(pair.ts))
			for i, tr := range pair.ts {
				tm := map[string]any{"text": tr.Text}
				setStr(tm, "language", tr.Language)
				trList[i] = tm
			}
			m[pair.k] = map[string]any{"translation": trList}
		}
	}
	return m
}

func readInputBytes(target string) ([]byte, error) {
	const maxBody = 32 * 1024 * 1024
	var rc io.ReadCloser
	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") {
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "arribo-gtfsrt/1")
		resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, fmt.Errorf("HTTP status %d", resp.StatusCode)
		}
		rc = resp.Body
	} else {
		f, err := os.Open(target)
		if err != nil {
			return nil, err
		}
		rc = f
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, maxBody+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxBody {
		return nil, errors.New("input exceeds 32 MiB limit")
	}
	return b, nil
}

// CLI handler: arribo gtfsrt-dump <file.pb | http(s)://url> [--json]
func runGtfsRtDump(args []string) int {
	usage := func() { fmt.Fprintln(os.Stderr, "Usage: arribo gtfsrt-dump <file.pb | http(s)://url> [--json]") }
	var target string
	var jsonOutput bool
	for _, arg := range args {
		if arg == "--json" {
			jsonOutput = true
		} else if strings.HasPrefix(arg, "-") || target != "" {
			usage()
			return 1
		} else {
			target = arg
		}
	}
	if target == "" {
		usage()
		return 1
	}

	b, err := readInputBytes(target)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fetch/read error:", err)
		return 2
	}
	msg, err := decodeGtfsRealtime(b)
	if err != nil {
		fmt.Fprintln(os.Stderr, "decode error:", err)
		return 2
	}
	if jsonOutput {
		out, err := json.Marshal(msg)
		if err != nil {
			fmt.Fprintln(os.Stderr, "json error:", err)
			return 2
		}
		fmt.Println(string(out))
		return 0
	}

	printSummary(msg)
	return 0
}

func printSummary(msg *FeedMessage) {
	fmt.Printf("GTFS-RT Version: %s\nTimestamp:       %d\nTotal Entities:  %d\n",
		msg.Header.GtfsRealtimeVersion, msg.Header.Timestamp, len(msg.Entities))
	var tu, vp, al []Entity
	for _, e := range msg.Entities {
		if e.TripUpdate != nil {
			tu = append(tu, e)
		}
		if e.Vehicle != nil {
			vp = append(vp, e)
		}
		if e.Alert != nil {
			al = append(al, e)
		}
	}
	fmt.Printf("Trip Updates:    %d\nVehicles:        %d\nAlerts:          %d\n", len(tu), len(vp), len(al))
	if len(tu) > 0 {
		fmt.Println("\nTrip Updates (first 3):")
		for _, e := range tu[:min(3, len(tu))] {
			del := "none"
			if e.TripUpdate.Delay != nil {
				del = fmt.Sprintf("%ds", *e.TripUpdate.Delay)
			}
			fmt.Printf("  [%s] TripID=%s RouteID=%s Delay=%s StopTimes=%d\n",
				e.ID, e.TripUpdate.Trip.TripID, e.TripUpdate.Trip.RouteID, del, len(e.TripUpdate.StopTimeUpdates))
		}
	}
	if len(vp) > 0 {
		fmt.Println("\nVehicles (first 3):")
		for _, e := range vp[:min(3, len(vp))] {
			var lat, lon float32
			if e.Vehicle.Position != nil {
				lat, lon = e.Vehicle.Position.Latitude, e.Vehicle.Position.Longitude
			}
			id, st := "", "unknown"
			if e.Vehicle.Vehicle != nil {
				id = e.Vehicle.Vehicle.ID
			}
			if e.Vehicle.CurrentStatus != nil {
				st = enumName(*e.Vehicle.CurrentStatus, vehicleStatusNames)
			}
			fmt.Printf("  [%s] VehicleID=%s Pos=(%.5f, %.5f) Status=%s StopID=%s\n",
				e.ID, id, lat, lon, st, e.Vehicle.StopID)
		}
	}
	if len(al) > 0 {
		fmt.Println("\nAlerts (first 3):")
		for _, e := range al[:min(3, len(al))] {
			hdr := ""
			if len(e.Alert.HeaderText) > 0 {
				hdr = e.Alert.HeaderText[0].Text
			}
			fmt.Printf("  [%s] Cause=%s Effect=%s Header=%q Entities=%d\n",
				e.ID, enumName(e.Alert.Cause, causeNames), enumName(e.Alert.Effect, effectNames), hdr, len(e.Alert.InformedEntities))
		}
	}
}

// wheelchairNames is VehicleDescriptor.WheelchairAccessible.
var wheelchairNames = []string{"NO_VALUE", "UNKNOWN", "WHEELCHAIR_ACCESSIBLE", "WHEELCHAIR_INACCESSIBLE"}
