package main

// Additional official Catalonia municipal urban bus networks (>10,000 inh.):
//   - TUS Sabadell (tus_sabadell): 24 urban lines via ATM/T-mobilitat CGIM (NAP 2059, agency TUS_)
//   - TMESA Terrassa (tmesa_terrassa): 17 urban lines via NAP 1175
//   - Rubíbus (rubibus): 7 urban lines via ATM/T-mobilitat CGIM (NAP 2059, agency RUB_)
//   - Urbans de Catalunya (atm_urban): 18 municipal urban networks via ATM/T-mobilitat CGIM (NAP 2059):
//       Barcelona: Vilafranca del Penedès (VFP_), Martorell (SSL_), Cubelles (CUB_), Abrera (ABR_)
//       Girona:    Figueres (FIG_), Olot (OLO_), Banyoles (TEI_53), Roses (ROS_),
//                  Castelló d'Empúries/Empuriabrava (EMP_), Puigcerdà (PUI_)
//       Tarragona: Tortosa (TTS_), Calafell (CAL_), Valls (VAL_), Amposta (AMP_),
//                  Torredembarra (TRD_), Cunit (CUN_), Mont-roig del Camp (MON_)
//       Lleida:    Balaguer (ALS_3229, ALS_3703)
//
// All are official NAP static GTFS feeds (no public real-time API exists for these
// networks; noHistory: true). Opt-in with ARRIBO_CATALONIA_URBAN=1 (on in compose)
// and requires NAP_API_KEY.

import (
	"os"
	"strings"
	"time"
)

const (
	tusSabadellAgencyID   = "tus_sabadell"
	tmesaTerrassaAgencyID = "tmesa_terrassa"
	rubibusAgencyID       = "rubibus"
	atmUrbanAgencyID      = "atm_urban"

	atmCGIMNapURL       = "https://nap.transportes.gob.es/api/Fichero/download/2059"
	tmesaTerrassaNapURL = "https://nap.transportes.gob.es/api/Fichero/download/1175"

	tusSabadellFilter = "agency:TUS_"
	rubibusFilter     = "agency:RUB_"
	atmUrbanFilter    = "agency:VFP_,CUB_,SSL_,ABR_,FIG_,OLO_,ROS_,EMP_,PUI_,TTS_,CAL_,VAL_,AMP_,TRD_,CUN_,MON_;route:TEI_53,ALS_3229,ALS_3703"
)

var (
	tusSabadellOperator = operatorInfo{
		ID: tusSabadellAgencyID, Name: "TUS Sabadell", ShortName: "Sabadell",
		Mode: "bus", Tier: "timetable", Method: "timetable",
		Source: "Recorreguts i horaris oficials GTFS de TUS Sabadell via ATM/T-mobilitat (NAP 2059; sense API pública de temps real).",
	}
	tmesaTerrassaOperator = operatorInfo{
		ID: tmesaTerrassaAgencyID, Name: "TMESA Terrassa", ShortName: "Terrassa",
		Mode: "bus", Tier: "timetable", Method: "timetable",
		Source: "Recorreguts i horaris oficials GTFS de TMESA Terrassa via NAP 1175 (sense API pública de temps real).",
	}
	rubibusOperator = operatorInfo{
		ID: rubibusAgencyID, Name: "Rubíbus", ShortName: "Rubí",
		Mode: "bus", Tier: "timetable", Method: "timetable",
		Source: "Recorreguts i horaris oficials GTFS de Rubíbus via ATM/T-mobilitat (NAP 2059; sense API pública de temps real).",
	}
	atmUrbanOperator = operatorInfo{
		ID: atmUrbanAgencyID, Name: "Urbans de Catalunya (ATM)", ShortName: "Urbans",
		Mode: "bus", Tier: "timetable", Method: "timetable",
		Source: "Recorreguts i horaris oficials GTFS de 18 xarxes urbanes municipals (Figueres, Olot, Banyoles, Roses, Empuriabrava, Puigcerdà, Tortosa, Calafell, Valls, Amposta, Torredembarra, Cunit, Mont-roig, Vilafranca, Martorell, Cubelles, Abrera i Balaguer) via ATM/T-mobilitat (NAP 2059).",
	}
)

var cataloniaUrbanOperators = []operatorInfo{
	tusSabadellOperator,
	tmesaTerrassaOperator,
	rubibusOperator,
	atmUrbanOperator,
}

func cataloniaUrbanSources() []rtSource {
	if os.Getenv("ARRIBO_CATALONIA_URBAN") != "1" {
		return nil
	}
	napKey := strings.TrimSpace(os.Getenv("NAP_API_KEY"))
	if napKey == "" {
		return nil
	}
	hdr := map[string]string{"ApiKey": napKey}
	return []rtSource{
		{
			AgencyID:          tusSabadellAgencyID,
			Mode:              "bus",
			vehicleEvery:      time.Minute,
			tripEvery:         time.Minute,
			staticURL:         atmCGIMNapURL,
			staticHeaders:     hdr,
			staticRouteFilter: tusSabadellFilter,
			noHistory:         true,
		},
		{
			AgencyID:      tmesaTerrassaAgencyID,
			Mode:          "bus",
			vehicleEvery:  time.Minute,
			tripEvery:     time.Minute,
			staticURL:     tmesaTerrassaNapURL,
			staticHeaders: hdr,
			noHistory:     true,
		},
		{
			AgencyID:          rubibusAgencyID,
			Mode:              "bus",
			vehicleEvery:      time.Minute,
			tripEvery:         time.Minute,
			staticURL:         atmCGIMNapURL,
			staticHeaders:     hdr,
			staticRouteFilter: rubibusFilter,
			noHistory:         true,
		},
		{
			AgencyID:          atmUrbanAgencyID,
			Mode:              "bus",
			vehicleEvery:      time.Minute,
			tripEvery:         time.Minute,
			staticURL:         atmCGIMNapURL,
			staticHeaders:     hdr,
			staticRouteFilter: atmUrbanFilter,
			noHistory:         true,
		},
	}
}

// matchGtfsRouteFilter evaluates a semicolon-separated filter spec like
// "agency:VFP_,FIG_;route:TEI_53,ALS_3229" against a route's agency_id and route_id.
func matchGtfsRouteFilter(spec, gtfsAgencyID, routeID string) bool {
	if spec == "" {
		return true
	}
	for _, clause := range strings.Split(spec, ";") {
		clause = strings.TrimSpace(clause)
		if strings.HasPrefix(clause, "agency:") {
			for _, pref := range strings.Split(strings.TrimPrefix(clause, "agency:"), ",") {
				pref = strings.TrimSpace(pref)
				if pref != "" && strings.HasPrefix(gtfsAgencyID, pref) {
					return true
				}
			}
		} else if strings.HasPrefix(clause, "route:") {
			for _, exact := range strings.Split(strings.TrimPrefix(clause, "route:"), ",") {
				exact = strings.TrimSpace(exact)
				if exact != "" && (routeID == exact || strings.HasPrefix(routeID, exact+".")) {
					return true
				}
			}
		}
	}
	return false
}

var atmUrbanCityPrefix = map[string]struct {
	tag  string
	city string
}{
	"VFP_": {"VFP", "Vilafranca del Penedès"},
	"CUB_": {"CUB", "Cubelles"},
	"SSL_": {"MAR", "Martorell"},
	"ABR_": {"ABR", "Abrera"},
	"FIG_": {"FIG", "Figueres"},
	"OLO_": {"OLO", "Olot"},
	"ROS_": {"ROS", "Roses"},
	"EMP_": {"EMP", "Empuriabrava"},
	"PUI_": {"PUI", "Puigcerdà"},
	"TTS_": {"TOR", "Tortosa"},
	"CAL_": {"CAL", "Calafell"},
	"VAL_": {"VAL", "Valls"},
	"AMP_": {"AMP", "Amposta"},
	"TRD_": {"TRD", "Torredembarra"},
	"CUN_": {"CUN", "Cunit"},
	"MON_": {"MON", "Mont-roig del Camp"},
	"TEI_": {"BAN", "Banyoles"},
	"ALS_": {"BAL", "Balaguer"},
}

// formatAtmUrbanRoute namespaces each municipal urban line code with its city
// tag (e.g. "FIG-L1", "CAL-L1") so identical short names across cities never
// collide in rtCatalog, and prepends the city name to route_long_name.
func formatAtmUrbanRoute(gtfsAgencyID, routeID, shortName, longName string) (string, string) {
	shortName = strings.TrimSpace(shortName)
	longName = strings.TrimSpace(longName)
	if shortName == "" {
		shortName = routeID
	}
	for pref, meta := range atmUrbanCityPrefix {
		if strings.HasPrefix(gtfsAgencyID, pref) || strings.HasPrefix(routeID, pref) {
			code := meta.tag + "-" + shortName
			name := longName
			if name == "" {
				name = meta.city + " · " + shortName
			} else if !strings.Contains(strings.ToLower(name), strings.ToLower(meta.city)) {
				name = meta.city + " · " + name
			}
			return code, name
		}
	}
	return shortName, longName
}
