package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Minimal protobuf wire-format encoder helper for tests.

func encVarint(v uint64) []byte {
	var buf []byte
	for {
		b := byte(v & 0x7f)
		v >>= 7
		if v == 0 {
			buf = append(buf, b)
			return buf
		}
		buf = append(buf, b|0x80)
	}
}

func encTag(fieldNum uint32, wireType int) []byte {
	return encVarint(uint64(fieldNum<<3) | uint64(wireType))
}

func encVarintField(fieldNum uint32, val uint64) []byte {
	return append(encTag(fieldNum, 0), encVarint(val)...)
}

func encFixed32Field(fieldNum uint32, val uint32) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, val)
	return append(encTag(fieldNum, 5), b...)
}

func encFloatField(fieldNum uint32, val float32) []byte {
	return encFixed32Field(fieldNum, math.Float32bits(val))
}

func encFixed64Field(fieldNum uint32, val uint64) []byte {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, val)
	return append(encTag(fieldNum, 1), b...)
}

func encDoubleField(fieldNum uint32, val float64) []byte {
	return encFixed64Field(fieldNum, math.Float64bits(val))
}

func encInt32Field(fieldNum uint32, val int32) []byte {
	return encVarintField(fieldNum, uint64(int64(val)))
}

func encInt64Field(fieldNum uint32, val int64) []byte {
	return encVarintField(fieldNum, uint64(val))
}

func encBytesField(fieldNum uint32, data []byte) []byte {
	res := encTag(fieldNum, 2)
	res = append(res, encVarint(uint64(len(data)))...)
	res = append(res, data...)
	return res
}

func encStringField(fieldNum uint32, s string) []byte {
	return encBytesField(fieldNum, []byte(s))
}

func encMsgField(fieldNum uint32, msgBytes []byte) []byte {
	return encBytesField(fieldNum, msgBytes)
}

func TestGtfsRtEmptyInput(t *testing.T) {
	msg, err := decodeGtfsRealtime([]byte{})
	if err != nil {
		t.Fatalf("unexpected error for empty byte slice: %v", err)
	}
	if msg == nil {
		t.Fatal("expected non-nil FeedMessage")
	}
	if len(msg.Entities) != 0 {
		t.Fatalf("expected 0 entities, got %d", len(msg.Entities))
	}

	msgNil, err := decodeGtfsRealtime(nil)
	if err != nil {
		t.Fatalf("unexpected error for nil byte slice: %v", err)
	}
	if msgNil == nil {
		t.Fatal("expected non-nil FeedMessage for nil input")
	}
}

func TestGtfsRtVehiclePosition(t *testing.T) {
	// Header: version="2.0", incrementality=0 (FULL_DATASET), timestamp=1700000000
	var header []byte
	header = append(header, encStringField(1, "2.0")...)
	header = append(header, encVarintField(2, 0)...)
	header = append(header, encVarintField(3, 1700000000)...)

	// TripDescriptor
	var tripDesc []byte
	tripDesc = append(tripDesc, encStringField(1, "trip-123")...)
	tripDesc = append(tripDesc, encStringField(2, "08:30:00")...)
	tripDesc = append(tripDesc, encStringField(3, "20261119")...)
	tripDesc = append(tripDesc, encVarintField(4, 0)...) // SCHEDULED
	tripDesc = append(tripDesc, encStringField(5, "L1")...)
	tripDesc = append(tripDesc, encVarintField(6, 1)...) // direction 1

	// VehicleDescriptor
	var vehDesc []byte
	vehDesc = append(vehDesc, encStringField(1, "veh-456")...)
	vehDesc = append(vehDesc, encStringField(2, "Bus 456")...)
	vehDesc = append(vehDesc, encStringField(3, "1234-ABC")...)

	// Position
	var pos []byte
	pos = append(pos, encFloatField(1, 41.5381)...)
	pos = append(pos, encFloatField(2, 2.4445)...)
	pos = append(pos, encFloatField(3, 90.5)...)
	pos = append(pos, encDoubleField(4, 12345.67)...)
	pos = append(pos, encFloatField(5, 11.2)...)

	// VehiclePosition
	var vp []byte
	vp = append(vp, encMsgField(1, tripDesc)...)
	vp = append(vp, encMsgField(2, pos)...)
	vp = append(vp, encVarintField(3, 4)...)          // current_stop_sequence = 4
	vp = append(vp, encVarintField(4, 1)...)          // current_status = STOPPED_AT (1)
	vp = append(vp, encVarintField(5, 1700000050)...) // timestamp
	vp = append(vp, encStringField(7, "stop-789")...)
	vp = append(vp, encMsgField(8, vehDesc)...)
	vp = append(vp, encVarintField(9, 2)...) // occupancy = FEW_SEATS_AVAILABLE (2)

	// Entity
	var entity []byte
	entity = append(entity, encStringField(1, "VP_01")...)
	entity = append(entity, encMsgField(4, vp)...)

	// FeedMessage
	var feed []byte
	feed = append(feed, encMsgField(1, header)...)
	feed = append(feed, encMsgField(2, entity)...)

	msg, err := decodeGtfsRealtime(feed)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}

	if msg.Header.GtfsRealtimeVersion != "2.0" {
		t.Errorf("expected version 2.0, got %q", msg.Header.GtfsRealtimeVersion)
	}
	if msg.Header.Timestamp != 1700000000 {
		t.Errorf("expected header timestamp 1700000000, got %d", msg.Header.Timestamp)
	}
	if len(msg.Entities) != 1 {
		t.Fatalf("expected 1 entity, got %d", len(msg.Entities))
	}

	e := msg.Entities[0]
	if e.ID != "VP_01" {
		t.Errorf("expected entity ID VP_01, got %q", e.ID)
	}
	if e.Vehicle == nil {
		t.Fatal("expected non-nil VehiclePosition")
	}
	if e.Vehicle.Trip == nil || e.Vehicle.Trip.TripID != "trip-123" || e.Vehicle.Trip.RouteID != "L1" {
		t.Errorf("unexpected trip: %+v", e.Vehicle.Trip)
	}
	if e.Vehicle.Trip.DirectionID == nil || *e.Vehicle.Trip.DirectionID != 1 {
		t.Errorf("expected directionId 1, got %v", e.Vehicle.Trip.DirectionID)
	}
	if e.Vehicle.Vehicle == nil || e.Vehicle.Vehicle.ID != "veh-456" || e.Vehicle.Vehicle.LicensePlate != "1234-ABC" {
		t.Errorf("unexpected vehicle descriptor: %+v", e.Vehicle.Vehicle)
	}
	if e.Vehicle.Position == nil {
		t.Fatal("expected non-nil Position")
	}
	if math.Abs(float64(e.Vehicle.Position.Latitude-41.5381)) > 0.0001 {
		t.Errorf("unexpected latitude: %f", e.Vehicle.Position.Latitude)
	}
	if math.Abs(float64(e.Vehicle.Position.Longitude-2.4445)) > 0.0001 {
		t.Errorf("unexpected longitude: %f", e.Vehicle.Position.Longitude)
	}
	if e.Vehicle.Position.Bearing == nil || math.Abs(float64(*e.Vehicle.Position.Bearing-90.5)) > 0.001 {
		t.Errorf("unexpected bearing: %v", e.Vehicle.Position.Bearing)
	}
	if e.Vehicle.Position.Odometer == nil || math.Abs(*e.Vehicle.Position.Odometer-12345.67) > 0.001 {
		t.Errorf("unexpected odometer: %v", e.Vehicle.Position.Odometer)
	}
	if e.Vehicle.Position.Speed == nil || math.Abs(float64(*e.Vehicle.Position.Speed-11.2)) > 0.001 {
		t.Errorf("unexpected speed: %v", e.Vehicle.Position.Speed)
	}
	if e.Vehicle.CurrentStatus == nil || *e.Vehicle.CurrentStatus != 1 {
		t.Errorf("expected currentStatus 1, got %v", e.Vehicle.CurrentStatus)
	}
	if e.Vehicle.CurrentStopSequence == nil || *e.Vehicle.CurrentStopSequence != 4 {
		t.Errorf("expected currentStopSequence 4, got %v", e.Vehicle.CurrentStopSequence)
	}
	if e.Vehicle.StopID != "stop-789" {
		t.Errorf("expected stopId stop-789, got %q", e.Vehicle.StopID)
	}
	if e.Vehicle.OccupancyStatus == nil || *e.Vehicle.OccupancyStatus != 2 {
		t.Errorf("expected occupancyStatus 2, got %v", e.Vehicle.OccupancyStatus)
	}
}

func TestGtfsRtTripUpdateNegativeDelay(t *testing.T) {
	// StopTimeEvent with negative delay (-120)
	var ste []byte
	ste = append(ste, encInt32Field(1, -120)...)
	ste = append(ste, encInt64Field(2, 1700000300)...)

	// StopTimeUpdate
	var stu []byte
	stu = append(stu, encVarintField(1, 3)...) // stop_sequence 3
	stu = append(stu, encMsgField(2, ste)...)  // arrival
	stu = append(stu, encStringField(4, "stop-50")...)
	stu = append(stu, encVarintField(5, 1)...) // schedule_relationship = SKIPPED

	// TripDescriptor
	var tripDesc []byte
	tripDesc = append(tripDesc, encStringField(1, "trip-neg")...)
	tripDesc = append(tripDesc, encStringField(5, "L2")...)

	// TripUpdate with negative delay (-120)
	var tu []byte
	tu = append(tu, encMsgField(1, tripDesc)...)
	tu = append(tu, encMsgField(2, stu)...)
	tu = append(tu, encVarintField(4, 1700000200)...) // timestamp
	tu = append(tu, encInt32Field(5, -120)...)        // delay -120

	// Entity
	var entity []byte
	entity = append(entity, encStringField(1, "TU_01")...)
	entity = append(entity, encMsgField(3, tu)...)

	// FeedMessage
	var feed []byte
	feed = append(feed, encMsgField(2, entity)...)

	msg, err := decodeGtfsRealtime(feed)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if len(msg.Entities) != 1 {
		t.Fatalf("expected 1 entity, got %d", len(msg.Entities))
	}

	tuDec := msg.Entities[0].TripUpdate
	if tuDec == nil {
		t.Fatal("expected non-nil TripUpdate")
	}
	if tuDec.Delay == nil || *tuDec.Delay != -120 {
		t.Errorf("expected trip delay -120, got %v", tuDec.Delay)
	}
	if len(tuDec.StopTimeUpdates) != 1 {
		t.Fatalf("expected 1 stop time update, got %d", len(tuDec.StopTimeUpdates))
	}
	stuDec := tuDec.StopTimeUpdates[0]
	if stuDec.StopSequence == nil || *stuDec.StopSequence != 3 {
		t.Errorf("expected stopSequence 3, got %v", stuDec.StopSequence)
	}
	if stuDec.Arrival == nil || stuDec.Arrival.Delay == nil || *stuDec.Arrival.Delay != -120 {
		t.Errorf("expected arrival delay -120, got %v", stuDec.Arrival)
	}
	if stuDec.Arrival.Time == nil || *stuDec.Arrival.Time != 1700000300 {
		t.Errorf("expected arrival time 1700000300, got %v", stuDec.Arrival.Time)
	}
	if stuDec.ScheduleRelationship != 1 {
		t.Errorf("expected scheduleRelationship 1 (SKIPPED), got %d", stuDec.ScheduleRelationship)
	}
}

func TestGtfsRtDeletedEntity(t *testing.T) {
	var entity []byte
	entity = append(entity, encStringField(1, "DEL_01")...)
	entity = append(entity, encVarintField(2, 1)...) // is_deleted = true

	var feed []byte
	feed = append(feed, encMsgField(2, entity)...)

	msg, err := decodeGtfsRealtime(feed)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if len(msg.Entities) != 1 {
		t.Fatalf("expected 1 entity, got %d", len(msg.Entities))
	}
	if !msg.Entities[0].IsDeleted {
		t.Errorf("expected is_deleted true, got false")
	}
	if msg.Entities[0].ID != "DEL_01" {
		t.Errorf("expected ID DEL_01, got %q", msg.Entities[0].ID)
	}
}

func TestGtfsRtAlertWithTranslatedHeader(t *testing.T) {
	// Translation
	var trans []byte
	trans = append(trans, encStringField(1, "Avaria tecnica")...)
	trans = append(trans, encStringField(2, "ca")...)

	// TranslatedString
	var ts []byte
	ts = append(ts, encMsgField(1, trans)...)

	// TimeRange
	var tr []byte
	tr = append(tr, encVarintField(1, 1700000000)...)
	tr = append(tr, encVarintField(2, 1700003600)...)

	// EntitySelector
	var sel []byte
	sel = append(sel, encStringField(2, "L1")...)
	sel = append(sel, encStringField(5, "stop-10")...)

	// Alert
	var alert []byte
	alert = append(alert, encMsgField(1, tr)...)
	alert = append(alert, encMsgField(5, sel)...)
	alert = append(alert, encVarintField(6, 3)...) // TECHNICAL_PROBLEM = 3
	alert = append(alert, encVarintField(7, 1)...) // NO_SERVICE = 1
	alert = append(alert, encMsgField(10, ts)...)  // header_text

	// Entity
	var entity []byte
	entity = append(entity, encStringField(1, "ALERT_01")...)
	entity = append(entity, encMsgField(5, alert)...)

	var feed []byte
	feed = append(feed, encMsgField(2, entity)...)

	msg, err := decodeGtfsRealtime(feed)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if len(msg.Entities) != 1 {
		t.Fatalf("expected 1 entity, got %d", len(msg.Entities))
	}

	a := msg.Entities[0].Alert
	if a == nil {
		t.Fatal("expected non-nil Alert")
	}
	if a.Cause != 3 {
		t.Errorf("expected cause 3, got %d", a.Cause)
	}
	if a.Effect != 1 {
		t.Errorf("expected effect 1, got %d", a.Effect)
	}
	if len(a.ActivePeriods) != 1 || a.ActivePeriods[0].Start != 1700000000 || a.ActivePeriods[0].End != 1700003600 {
		t.Errorf("unexpected active period: %+v", a.ActivePeriods)
	}
	if len(a.InformedEntities) != 1 || a.InformedEntities[0].RouteID != "L1" || a.InformedEntities[0].StopID != "stop-10" {
		t.Errorf("unexpected informed entity: %+v", a.InformedEntities)
	}
	if len(a.HeaderText) != 1 || a.HeaderText[0].Text != "Avaria tecnica" || a.HeaderText[0].Language != "ca" {
		t.Errorf("unexpected header text: %+v", a.HeaderText)
	}
}

func TestGtfsRtUnknownFieldsSkipped(t *testing.T) {
	// Build message with unknown fields of wire types 0, 1, 2, 5 at multiple levels.

	// Unknown fields to inject
	injectUnknowns := func(base []byte) []byte {
		b := append(base, encVarintField(990, 12345)...)           // wt 0
		b = append(b, encFixed64Field(991, 0x1122334455667788)...) // wt 1
		b = append(b, encStringField(992, "unknown payload")...)   // wt 2
		b = append(b, encFixed32Field(993, 0x12345678)...)         // wt 5
		return b
	}

	var pos []byte
	pos = append(pos, encFloatField(1, 41.5)...)
	pos = append(pos, encFloatField(2, 2.4)...)
	pos = injectUnknowns(pos)

	var vp []byte
	vp = append(vp, encMsgField(2, pos)...)
	vp = append(vp, encStringField(7, "stop-X")...)
	vp = injectUnknowns(vp)

	var entity []byte
	entity = append(entity, encStringField(1, "E_UNK")...)
	entity = append(entity, encMsgField(4, vp)...)
	entity = injectUnknowns(entity)

	var feed []byte
	feed = append(feed, encMsgField(2, entity)...)
	feed = injectUnknowns(feed)

	msg, err := decodeGtfsRealtime(feed)
	if err != nil {
		t.Fatalf("failed to decode message with unknown fields: %v", err)
	}
	if len(msg.Entities) != 1 {
		t.Fatalf("expected 1 entity, got %d", len(msg.Entities))
	}
	e := msg.Entities[0]
	if e.ID != "E_UNK" {
		t.Errorf("expected ID E_UNK, got %q", e.ID)
	}
	if e.Vehicle == nil || e.Vehicle.StopID != "stop-X" {
		t.Errorf("unexpected vehicle: %+v", e.Vehicle)
	}
	if e.Vehicle.Position == nil || math.Abs(float64(e.Vehicle.Position.Latitude-41.5)) > 0.001 {
		t.Errorf("unexpected position: %+v", e.Vehicle.Position)
	}
}

func TestGtfsRtTruncatedInput(t *testing.T) {
	// Build a valid message with header and entity
	var header []byte
	header = append(header, encStringField(1, "2.0")...)
	header = append(header, encVarintField(3, 1700000000)...)

	var pos []byte
	pos = append(pos, encFloatField(1, 41.5)...)
	pos = append(pos, encFloatField(2, 2.4)...)

	var vp []byte
	vp = append(vp, encMsgField(2, pos)...)

	var entity []byte
	entity = append(entity, encStringField(1, "E1")...)
	entity = append(entity, encMsgField(4, vp)...)

	var valid []byte
	valid = append(valid, encMsgField(1, header)...)
	valid = append(valid, encMsgField(2, entity)...)

	// Decode of full message must succeed
	if _, err := decodeGtfsRealtime(valid); err != nil {
		t.Fatalf("valid message failed to decode: %v", err)
	}

	// Every prefix length must fail with error and NEVER panic
	for i := 1; i < len(valid); i++ {
		prefix := valid[:i]
		_, err := decodeGtfsRealtime(prefix)
		if err == nil {
			// A prefix could theoretically form a complete shorter protobuf message only if
			// it cut right after a complete top-level message. But our message has header + entity,
			// check if header alone is valid
			if i != len(encMsgField(1, header)) {
				t.Fatalf("expected error for truncated prefix len %d of %d, got nil", i, len(valid))
			}
		}
	}
}

func TestGtfsRtOverLongVarint(t *testing.T) {
	// A varint with 11 bytes where all have MSB set
	overLong := []byte{0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01}
	_, err := decodeGtfsRealtime(overLong)
	if err == nil {
		t.Fatal("expected error for over-long varint, got nil")
	}
	if !strings.Contains(err.Error(), "over-long") && !strings.Contains(err.Error(), "varint") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestGtfsRtJSONOutput(t *testing.T) {
	var header []byte
	header = append(header, encStringField(1, "2.0")...)
	header = append(header, encVarintField(3, 1795113820)...)

	var pos []byte
	pos = append(pos, encFloatField(1, 37.18)...)
	pos = append(pos, encFloatField(2, -5.79)...)

	var tripDesc []byte
	tripDesc = append(tripDesc, encStringField(1, "T1")...)

	var vehDesc []byte
	vehDesc = append(vehDesc, encStringField(1, "23573")...)
	vehDesc = append(vehDesc, encStringField(2, "C1-23573")...)

	var vp []byte
	vp = append(vp, encMsgField(1, tripDesc)...)
	vp = append(vp, encMsgField(2, pos)...)
	vp = append(vp, encVarintField(4, 0)...)          // INCOMING_AT = 0
	vp = append(vp, encVarintField(5, 1795113817)...) // timestamp
	vp = append(vp, encStringField(7, "51200")...)
	vp = append(vp, encMsgField(8, vehDesc)...)

	var entity []byte
	entity = append(entity, encStringField(1, "VP_C1-23573")...)
	entity = append(entity, encMsgField(4, vp)...)

	var feed []byte
	feed = append(feed, encMsgField(1, header)...)
	feed = append(feed, encMsgField(2, entity)...)

	msg, err := decodeGtfsRealtime(feed)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}

	rawJSON, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("json marshal failed: %v", err)
	}

	var m map[string]interface{}
	if err := json.Unmarshal(rawJSON, &m); err != nil {
		t.Fatalf("unmarshal json failed: %v", err)
	}

	// Verify header
	h, ok := m["header"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected header object, got: %v", m["header"])
	}
	if h["gtfsRealtimeVersion"] != "2.0" {
		t.Errorf("expected gtfsRealtimeVersion '2.0', got %v", h["gtfsRealtimeVersion"])
	}
	if h["timestamp"] != "1795113820" {
		t.Errorf("expected string timestamp '1795113820', got %v", h["timestamp"])
	}

	// Verify entity
	ents, ok := m["entity"].([]interface{})
	if !ok || len(ents) != 1 {
		t.Fatalf("expected 1 entity array, got %v", m["entity"])
	}
	ent := ents[0].(map[string]interface{})
	if ent["id"] != "VP_C1-23573" {
		t.Errorf("expected id 'VP_C1-23573', got %v", ent["id"])
	}
	veh := ent["vehicle"].(map[string]interface{})
	if veh["currentStatus"] != "INCOMING_AT" {
		t.Errorf("expected currentStatus 'INCOMING_AT', got %v", veh["currentStatus"])
	}
	if veh["timestamp"] != "1795113817" {
		t.Errorf("expected timestamp '1795113817', got %v", veh["timestamp"])
	}
	if veh["stopId"] != "51200" {
		t.Errorf("expected stopId '51200', got %v", veh["stopId"])
	}
}

func TestGtfsRtCLIDump(t *testing.T) {
	// Build valid pb file
	var header []byte
	header = append(header, encStringField(1, "2.0")...)
	header = append(header, encVarintField(3, 1700000000)...)

	var pos []byte
	pos = append(pos, encFloatField(1, 41.5)...)
	pos = append(pos, encFloatField(2, 2.4)...)

	var vp []byte
	vp = append(vp, encMsgField(2, pos)...)

	var entity []byte
	entity = append(entity, encStringField(1, "E1")...)
	entity = append(entity, encMsgField(4, vp)...)

	var feed []byte
	feed = append(feed, encMsgField(1, header)...)
	feed = append(feed, encMsgField(2, entity)...)

	tmpDir := t.TempDir()
	validPath := filepath.Join(tmpDir, "feed.pb")
	if err := os.WriteFile(validPath, feed, 0644); err != nil {
		t.Fatalf("failed to write test file: %v", err)
	}

	// Test usage error (exit 1)
	if code := runGtfsRtDump([]string{}); code != 1 {
		t.Errorf("expected exit 1 for no args, got %d", code)
	}
	if code := runGtfsRtDump([]string{"--badflag"}); code != 1 {
		t.Errorf("expected exit 1 for bad flag, got %d", code)
	}

	// Test non-existent file (exit 2)
	if code := runGtfsRtDump([]string{"/nonexistent/feed.pb"}); code != 2 {
		t.Errorf("expected exit 2 for missing file, got %d", code)
	}

	// Test valid file dump summary (exit 0)
	if code := runGtfsRtDump([]string{validPath}); code != 0 {
		t.Errorf("expected exit 0 for valid file, got %d", code)
	}

	// Test valid file with --json (exit 0)
	if code := runGtfsRtDump([]string{validPath, "--json"}); code != 0 {
		t.Errorf("expected exit 0 for valid file --json, got %d", code)
	}

	// Test HTTP GET via httptest
	var userAgentReceived string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userAgentReceived = r.Header.Get("User-Agent")
		if r.URL.Path == "/404" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path == "/oversized" {
			// Write 33 MiB
			chunk := bytes.Repeat([]byte("A"), 1024*1024)
			for i := 0; i < 33; i++ {
				w.Write(chunk)
			}
			return
		}
		w.Write(feed)
	}))
	defer ts.Close()

	if code := runGtfsRtDump([]string{ts.URL + "/feed.pb"}); code != 0 {
		t.Errorf("expected exit 0 for HTTP fetch, got %d", code)
	}
	if userAgentReceived != "arribo-gtfsrt/1" {
		t.Errorf("expected User-Agent 'arribo-gtfsrt/1', got %q", userAgentReceived)
	}

	// HTTP 404
	if code := runGtfsRtDump([]string{ts.URL + "/404"}); code != 2 {
		t.Errorf("expected exit 2 for HTTP 404, got %d", code)
	}

	// HTTP oversized
	if code := runGtfsRtDump([]string{ts.URL + "/oversized"}); code != 2 {
		t.Errorf("expected exit 2 for oversized HTTP response, got %d", code)
	}

	// Oversized local file
	hugePath := filepath.Join(tmpDir, "huge.pb")
	hugeFile, err := os.Create(hugePath)
	if err != nil {
		t.Fatal(err)
	}
	zeroes := make([]byte, 1024*1024)
	for i := 0; i < 33; i++ {
		hugeFile.Write(zeroes)
	}
	hugeFile.Close()

	if code := runGtfsRtDump([]string{hugePath}); code != 2 {
		t.Errorf("expected exit 2 for oversized file, got %d", code)
	}
}

// Silence unused io import warning if any
var _ = io.EOF
