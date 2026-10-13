/* ==========================================================================
 * Street Light GIS · config.js
 * Section 1: every threshold, rule and example value in one place.
 *
 * Values marked EXAMPLE are illustrative only. They are not real regulations,
 * contract terms, penalty rates or warranty periods; replace them with the
 * figures from your own contracts and standards.
 *
 * Plain script (no modules) so the app still runs from file://. Every script
 * shares one global scope; load order is set in index.html.
 * ========================================================================== */
'use strict';

// ---- 1.1 Basemap -----------------------------------------------------------
// Optional: a free CARTO Basemaps key (https://carto.com/basemaps/apikey) switches the night map to
// CARTO Dark Matter. Keyless CARTO tiles come back stamped "API KEY REQUIRED", so without a key the
// night map is OpenFreeMap's "dark" vector style (free, no key) drawn by MapLibre GL in Leaflet.
const CARTO_API_KEY = '';

// ---- 1.2 Map and symbols ---------------------------------------------------
const MAP_MIN_ZOOM = 14;                 // furthest the map zooms out
const MAP_MAX_ZOOM = 20;                 // closest the map zooms in
const MAP_START_ZOOM = 16;               // before the pilot zone is fitted to the screen
const SNAP_RADIUS_M = 40;                // a report click snaps to the nearest pole within this distance
const HIT_TOLERANCE_PX = 14;             // a click this close to a pole selects it
const HALO_RADIUS_M = 16;                // light pool drawn around a working lamp
const HEAT_RADIUS_M = 38;                // ground radius of each faulty lamp's heat
const HEAT_INTENSITY = 0.5;              // weight of one faulty lamp in the heatmap
const HEAT_STOPS = [0.2, 0.4, 0.55, 0.7, 0.85, 1]; // positions of the colour tokens --heat-1 … --heat-6 on the heat ramp
const ENERGY_MAX_RADIUS_PX = 17;         // largest proportional symbol on the energy layer
const ENERGY_MIN_RADIUS_PX = 3.5;        // smallest proportional symbol on the energy layer
const ENERGY_LEGEND_KWH = [25, 50, 100, 200]; // reference circles in the energy legend
const ANOMALY_RATIO = 1.5;               // monthly kWh above this multiple of the night-hours baseline = anomaly
const TARIFF_FALLBACK_INR = 8;           // ₹/kWh, only used when the dataset has no tariff

// Status colours are reserved for status, and each status also has its own shape,
// so the map never relies on red-vs-green alone. `token` names the colour in style.css.
const STATUS = {
  Functional: { key: 'ok', label: 'Functional', token: '--ok', icon: 'fa-circle-check' },
  Faulty: { key: 'fault', label: 'Faulty', token: '--bad', icon: 'fa-triangle-exclamation' },
  'Under Maintenance': { key: 'maint', label: 'Under maintenance', token: '--warn', icon: 'fa-screwdriver-wrench' },
};
const STATUS_ORDER = ['Functional', 'Faulty', 'Under Maintenance'];
const METER_ORDER = ['Functional', 'Under Maintenance', 'Faulty'];

// ---- 1.3 Views (a demo switch, not authentication) --------------------------
const ROLES = [
  { id: 'citizen', label: 'Citizen' },
  { id: 'operator', label: 'Operator' },
  { id: 'field', label: 'Field crew' },
  { id: 'management', label: 'Management' },
];
const DEFAULT_ROLE = 'operator';           // view shown when the URL names none
const ROLE_ANALYSES = {                    // spatial analyses each view can switch on
  citizen: [],
  operator: ['heatmap', 'energy', 'feeder'],
  field: ['feeder'],
  management: ['heatmap', 'energy', 'feeder'],
};
const ROLE_OVERLAYS = {                    // overlays each view lists in the layers panel
  citizen: ['reports', 'zone'],
  operator: ['reports', 'shutdowns', 'landmarks', 'coverage', 'water', 'permits', 'zone'],
  field: ['reports', 'shutdowns', 'landmarks', 'permits', 'zone'],
  management: ['coverage', 'landmarks', 'water', 'permits', 'zone'],
};

// ---- 1.4 Clock -------------------------------------------------------------
// Demo only: ?now=2026-10-13T19:30 starts the app's clock at that IST time (it keeps running from there).
const DEMO_CLOCK_PARAM = 'now';
const TIME_ZONE = 'Asia/Kolkata';        // IST, UTC+5:30, no daylight saving
const IST_OFFSET = '+05:30';
const SUN_ZENITH_DEG = 90.833;           // sunrise/sunset: sun's upper edge on the horizon, with refraction
const CLOCK_TICK_MS = 30_000;            // how often time-based states (SLA, escalation, dusk checks) refresh

// ---- 1.5 Dark spots, coverage and criticality (A) ---------------------------
const MIN_DARK_RUN = 2;                  // consecutive dark poles (Faulty or Under maintenance) that form an unlit stretch
const OPEN_ROAD_GAP_FACTOR = 4;          // a ring gap wider than this many times the median spacing means the road ends there
const DESIGN_SPACING_RATIO = 5.5;        // EXAMPLE: spacing above this multiple of pole height = coverage gap (add a pole)
const CRITICALITY_RADIUS_M = 40;         // landmarks within this distance raise a pole's criticality
const CRITICALITY_HIGH = 3;              // landmark score at or above which a pole is high criticality
const CRITICALITY_MEDIUM = 2;            // landmark score at or above which a pole is medium criticality
const LANDMARK_KINDS = {                 // weight = how much a nearby landmark adds to criticality
  metro_exit: { label: 'Metro exit', weight: 3, icon: 'fa-train-subway' },
  subway: { label: 'Subway', weight: 3, icon: 'fa-stairs' },
  bus_stop: { label: 'Bus stop', weight: 2, icon: 'fa-bus' },
  crossing: { label: 'Pedestrian crossing', weight: 2, icon: 'fa-person-walking' },
  atm: { label: 'ATM', weight: 1, icon: 'fa-money-bill' },
  parking: { label: 'Parking', weight: 1, icon: 'fa-square-parking' },
};

// ---- 1.6 Citizen reporting (B) ----------------------------------------------
const BASE_URL = '';                     // public address of this app; QR labels link to BASE_URL#report=<UID>
const DUPLICATE_RADIUS_M = 30;           // a location-only report this close to an open location ticket merges into it
const DUPLICATE_WINDOW_HOURS = 48;       // ...if that ticket was raised within this many hours
// Report categories, in the order the chips appear. `team` routes the ticket, `severity` feeds the
// priority score, `darkens` marks the pole Faulty (a tree blocking a working lamp, or a lamp burning
// by day, leaves the status alone). Labels live in CITIZEN_TEXT (cat_<id>).
const REPORT_CATEGORIES = [
  { id: 'not_working', team: 'lamp', severity: 30, darkens: true, icon: 'fa-lightbulb' },
  { id: 'flickering', team: 'lamp', severity: 20, darkens: true, icon: 'fa-bolt-lightning' },
  { id: 'day_burning', team: 'lamp', severity: 12, darkens: false, icon: 'fa-sun' },
  { id: 'damaged', team: 'lamp', severity: 40, darkens: true, icon: 'fa-triangle-exclamation' },
  { id: 'exposed', team: 'emergency', severity: 70, darkens: true, icon: 'fa-plug-circle-exclamation' },
  { id: 'shock', team: 'emergency', severity: 75, darkens: true, icon: 'fa-bolt' },
  { id: 'blocked', team: 'horticulture', severity: 15, darkens: false, icon: 'fa-tree' },
  { id: 'other', team: 'survey', severity: 15, darkens: false, icon: 'fa-comment-dots' },
];
const PHONE_PATTERN = /^(\+?91)?[6-9]\d{9}$/; // optional mobile number: 10-digit Indian mobile
const SHUTDOWN_HOLDS = ['not_working', 'flickering']; // during a planned shutdown these are logged, not dispatched (safety reports still go out)
const SHUTDOWN_AREA_M = 60;              // a location report this close to a pole switched off by a shutdown is in the shutdown area

// ---- 1.7 Triage (C) ----------------------------------------------------------
const CIRCUIT_FAULT_SHARE = 0.6;         // this share of a circuit's poles dark = panel or breaker fault
const MIN_CABLE_FAULT_RUN = 3;           // dark poles needed at the far end of a circuit to call a cable fault
const TEAMS = {                          // who a ticket goes to
  lamp: { label: 'Electrical · lamp contractor' },
  cable: { label: 'Electrical · cable & panel team' },
  emergency: { label: 'Emergency' },
  horticulture: { label: 'Horticulture / enforcement' },
  survey: { label: 'Zonal survey team' },
};
const CIRCUIT_SEVERITY = { cable: 45, panel: 50 }; // priority score of a collapsed circuit ticket
const CRITICALITY_BONUS = { High: 15, Medium: 8 };  // added to the priority score near busy landmarks
const REPORT_BONUS = 4;                  // added per citizen report beyond the first...
const REPORT_BONUS_CAP = 3;              // ...for at most this many extra reports (keeps the raise modest)
const DARK_RUN_BONUS = [[200, 15], [100, 8]]; // [unlit metres, score added], longest first
const PRIORITY_THRESHOLDS = [['Critical', 65], ['High', 42], ['Medium', 25]]; // score at or above -> priority; else Low
const PRIORITY_RANK = { Low: 0, Medium: 1, High: 2, Critical: 3 };
const EMERGENCY_SLA_HOURS = 4;           // EXAMPLE: hours to make an emergency safe
const SLA_BASE_HOURS = { cable: 24, horticulture: 72, survey: 48 }; // EXAMPLE; lamp tickets use the contractor's SLA
const SLA_MODIFIERS = {                  // EXAMPLE: multiply the base SLA (emergencies are never stretched)
  highCriticality: { factor: 0.5, label: 'halved near a busy landmark' },
  mediumCriticality: { factor: 0.75, label: 'cut by a quarter near a landmark' },
  longDarkRun: { factor: 0.5, label: 'halved for a long dark stretch' },
  manyReports: { factor: 0.75, label: 'cut by a quarter for repeated reports' },
};
const LONG_DARK_RUN_M = 200;             // unlit stretch at least this long uses the longDarkRun modifier
const MANY_REPORTS = 3;                  // this many citizen reports uses the manyReports modifier
const SLA_MIN_HOURS = 4;                 // modifiers never cut an SLA below this
const ESCALATION = [                     // EXAMPLE thresholds, as multiples of the ticket's SLA
  { level: 'JE', title: 'Junior Engineer', at: 0 },
  { level: 'AE', title: 'Assistant Engineer', at: 1 },
  { level: 'EE', title: 'Executive Engineer', at: 2 },
];

// ---- 1.8 Field crew (D) ------------------------------------------------------
const CCMS_CONFIRM_DELAY_MIN = 10;       // simulated: minutes after dark (or after closing) until a CCMS node reports the lamp on
const WORK_ORDER_GROUP_M = 60;           // jobs closer together than this become one stop
const LAMP_CATEGORIES = ['not_working', 'flickering', 'day_burning']; // categories that can need lamp spares...
const NOT_A_LAMP_JOB = /cable|supply|junction|stolen|theft|pole|tree|canopy|hoarding|walkway/i; // ...unless the issue says otherwise
const SPARES = {                         // what a crew carries for a lamp job, by fixture type
  LED: (p) => `${p.wattage} W LED fixture/driver, ${p.cct_k} K`,
  HPS: (p) => `${p.wattage} W HPS lamp, ignitor, ${p.cct_k} K`,
  'Metal Halide': (p) => `${p.wattage} W metal halide lamp, ballast`,
};

// ---- 1.9 Management (E) ------------------------------------------------------
const REPEAT_WINDOW_DAYS = 30;           // a pole failing again within this many days of a closure = repeat failure
const CHRONIC_FAILURES = 3;              // failures in the window below that make a pole chronic
const CHRONIC_WINDOW_DAYS = 365;         // look-back window for chronic poles
const SCORECARD_WINDOW_DAYS = 365;       // contractor scorecard period
const EXAMPLE_DEDUCTION_PER_BREACH_INR = 500; // EXAMPLE payment rule, not a contract term: deduction per SLA breach
const RECONCILIATION_GAP_SHARE = 0.08;   // metered energy this share above the lamps' own use = unexplained consumption
const EXTERNAL_CAUSE = /cable|theft|vehicle|MCB/i; // failures not blamed on the fixture batch
const WEAK_BATCH_RATIO = 2;              // a fixture batch failing at this multiple of the zone rate is flagged...
const WEAK_BATCH_MIN_FAILURES = 5;       // ...once it has at least this many failures (a small batch is too noisy to judge)

// ---- 1.10 Seasonal and special situations (F) ---------------------------------
const EARTHING_CHECK_MAX_MONTHS = 12;    // EXAMPLE: earthing checks older than this are due before the monsoon
const MONSOON_START = '2027-06-25';      // EXAMPLE: date the pre-monsoon checks must be done by
const WATERLOGGING_NEAR_M = 15;          // margin beyond a waterlogging spot's radius that still counts as near
const EVENT_ROUTE_BUFFER_M = 25;         // poles within this distance of an event route are checked
const PERMIT_PROXIMITY_M = 30;           // a circuit or cable fault this close to an active permit may be third-party damage
const PANEL_LOAD_WARN_SHARE = 0.8;       // warn when a panel's load passes this share of its capacity
const PANEL_POWER_FACTOR = 0.9;          // kVA rating × power factor = usable kW
const FESTIVE_WINDOW = { start: '2026-10-10', end: '2026-11-15', label: 'Festive season' }; // EXAMPLE dates

// ---- 1.11 Citizen text (EN / हिन्दी) ------------------------------------------
// Every string the Citizen view shows, in one dictionary. {name} marks a value filled in at run time.
// The Hindi strings are a first draft and need review by a native speaker before any public use.
const CITIZEN_TEXT = {
  en: {
    brand_sub: 'Connaught Place pilot · NDMC area, New Delhi',
    mock_chip: 'MVP · mock data',
    mock_chip_tip: 'Demo running on synthetic data',
    view_label: 'View',
    search_placeholder: 'Search a light ID or road',
    search_label: 'Search lights and roads',
    search_empty: 'No matches for “{q}”',
    my_reports: 'My reports',
    new_update: 'New update',
    report_cta: 'Report an issue',
    report_cancel: 'Cancel',
    report_hint: 'Tap a light or any spot on the map',
    esc_hint: 'to cancel',
    legend: 'Legend',
    legend_status: 'Streetlight status',
    legend_filter: 'tap to filter',
    layers: 'Layers',
    overlays: 'Show on map',
    basemap: 'Basemap',
    night: 'Night',
    satellite: 'Satellite',
    overlay_reports: 'My reports',
    overlay_zone: 'Pilot zone boundary',
    status_Functional: 'Working',
    status_Faulty: 'Not working',
    'status_Under Maintenance': 'Being repaired',
    zoom_in: 'Zoom in',
    zoom_out: 'Zoom out',
    zoom_home: 'Fit pilot zone',
    close: 'Close',
    back: 'Back',
    form_eyebrow: 'Report an issue',
    form_title: 'What’s wrong?',
    form_problem: 'Problem',
    form_pick: 'Pick one.',
    form_note: 'Note',
    optional: 'optional',
    form_note_placeholder: 'e.g. Third light from the Janpath corner, dark since Tuesday',
    form_photo: 'Add photo',
    form_photo_not_image: 'Choose an image file',
    form_contact: 'Contact details',
    form_name: 'Your name',
    form_mobile: 'Mobile',
    form_mobile_error: 'Enter a 10-digit Indian mobile number, or leave it blank.',
    form_demo: 'Demo: saved in this browser session only. Nothing is sent.',
    form_send: 'Send report',
    loc_snapped: 'Nearest light, {m} m from your tap.',
    loc_selected: 'Light selected on the map.',
    loc_none: 'No light within {m} m. Someone will check this spot.',
    loc_already: 'Already reported. Your report will be added to it.',
    shutdown_until: 'Planned power shutdown until {time}.',
    shutdown_logged: 'Your report will be logged. No crew will be sent.',
    safety: 'Stay away from the pole. If someone is hurt, call 112.',
    cat_not_working: 'Not working',
    cat_flickering: 'Flickering',
    cat_day_burning: 'On during the day',
    cat_damaged: 'Pole damaged or leaning',
    cat_exposed: 'Exposed wires / open box',
    cat_shock: 'Shock or sparking',
    cat_blocked: 'Blocked by tree or hoarding',
    cat_other: 'Something else',
    toast_sent: 'Report sent',
    toast_sent_body: 'Reference {id}. Follow it in My reports.',
    toast_merged: 'Added to an earlier report',
    toast_merged_body: '{n} reports for this light so far.',
    toast_logged: 'Report logged',
    my_reports_note: 'Simulated: updates appear here during this session only. No SMS or WhatsApp is sent.',
    my_reports_empty: 'No reports yet.',
    map_location: 'Map location',
    st_received: 'Received',
    st_assigned: 'Crew assigned',
    st_checking: 'Repaired · checking after dark',
    st_fixed: 'Fixed',
    st_logged: 'Logged · planned shutdown until {time}',
    st_reopened: 'Reopened',
    fixed_q: 'Fixed?',
    yes: 'Yes',
    no: 'No',
    fixed_thanks: 'Thanks for confirming.',
    reopened_toast: 'Reopened. A crew will check again.',
    pole_eyebrow: 'Streetlight',
    pole_reported: 'Already reported. Repair under way.',
    pole_ok: 'No known problem.',
    pole_shutdown: 'Off for a planned power shutdown until {time}.',
  },
  hi: {
    brand_sub: 'कनॉट प्लेस पायलट · एनडीएमसी क्षेत्र, नई दिल्ली',
    mock_chip: 'डेमो · नमूना डेटा',
    mock_chip_tip: 'नमूना (कृत्रिम) डेटा पर चलने वाला डेमो',
    view_label: 'व्यू',
    search_placeholder: 'बत्ती का नंबर या सड़क खोजें',
    search_label: 'बत्तियां और सड़कें खोजें',
    search_empty: '“{q}” के लिए कुछ नहीं मिला',
    my_reports: 'मेरी शिकायतें',
    new_update: 'नया अपडेट',
    report_cta: 'शिकायत दर्ज करें',
    report_cancel: 'रद्द करें',
    report_hint: 'मैप पर किसी बत्ती या जगह पर टैप करें',
    esc_hint: 'रद्द करने के लिए',
    legend: 'संकेत',
    legend_status: 'स्ट्रीटलाइट की स्थिति',
    legend_filter: 'छांटने के लिए टैप करें',
    layers: 'परतें',
    overlays: 'मैप पर दिखाएं',
    basemap: 'आधार मैप',
    night: 'रात',
    satellite: 'सैटेलाइट',
    overlay_reports: 'मेरी शिकायतें',
    overlay_zone: 'पायलट क्षेत्र की सीमा',
    status_Functional: 'चालू',
    status_Faulty: 'नहीं जल रही',
    'status_Under Maintenance': 'मरम्मत जारी',
    zoom_in: 'ज़ूम इन',
    zoom_out: 'ज़ूम आउट',
    zoom_home: 'पूरा पायलट क्षेत्र दिखाएं',
    close: 'बंद करें',
    back: 'वापस',
    form_eyebrow: 'शिकायत दर्ज करें',
    form_title: 'क्या समस्या है?',
    form_problem: 'समस्या',
    form_pick: 'एक विकल्प चुनें।',
    form_note: 'टिप्पणी',
    optional: 'वैकल्पिक',
    form_note_placeholder: 'जैसे: जनपथ कोने से तीसरी बत्ती, मंगलवार से बंद',
    form_photo: 'फोटो जोड़ें',
    form_photo_not_image: 'कोई चित्र फ़ाइल चुनें',
    form_contact: 'संपर्क विवरण',
    form_name: 'आपका नाम',
    form_mobile: 'मोबाइल',
    form_mobile_error: '10 अंकों का भारतीय मोबाइल नंबर डालें, या खाली छोड़ दें।',
    form_demo: 'डेमो: केवल इस ब्राउज़र सत्र में सहेजा जाता है। कुछ भी भेजा नहीं जाता।',
    form_send: 'शिकायत भेजें',
    loc_snapped: 'आपके टैप से {m} मी. दूर की सबसे नज़दीकी बत्ती।',
    loc_selected: 'मैप पर चुनी गई बत्ती।',
    loc_none: '{m} मी. के भीतर कोई बत्ती नहीं। इस जगह की जांच की जाएगी।',
    loc_already: 'यह पहले से दर्ज है। आपकी शिकायत उसी में जोड़ी जाएगी।',
    shutdown_until: '{time} तक बिजली की नियोजित कटौती है।',
    shutdown_logged: 'आपकी शिकायत दर्ज होगी, पर कोई टीम नहीं भेजी जाएगी।',
    safety: 'खंभे से दूर रहें। कोई घायल हो तो 112 पर कॉल करें।',
    cat_not_working: 'नहीं जल रही',
    cat_flickering: 'टिमटिमा रही है',
    cat_day_burning: 'दिन में जल रही है',
    cat_damaged: 'खंभा टूटा या झुका है',
    cat_exposed: 'खुले तार / खुला बॉक्स',
    cat_shock: 'करंट या चिंगारी',
    cat_blocked: 'पेड़ या होर्डिंग से रोशनी रुकी',
    cat_other: 'कुछ और',
    toast_sent: 'शिकायत भेजी गई',
    toast_sent_body: 'संदर्भ {id}। इसे “मेरी शिकायतें” में देखें।',
    toast_merged: 'पहले की शिकायत में जोड़ा गया',
    toast_merged_body: 'इस बत्ती की अब तक {n} शिकायतें।',
    toast_logged: 'शिकायत दर्ज की गई',
    my_reports_note: 'सिमुलेशन: अपडेट केवल इसी सत्र में यहां दिखते हैं। कोई SMS या WhatsApp नहीं भेजा जाता।',
    my_reports_empty: 'अभी कोई शिकायत नहीं।',
    map_location: 'मैप पर जगह',
    st_received: 'प्राप्त हुई',
    st_assigned: 'टीम भेजी गई',
    st_checking: 'ठीक की गई · अंधेरा होने पर जांच',
    st_fixed: 'ठीक हो गई',
    st_logged: 'दर्ज · {time} तक नियोजित बिजली कटौती',
    st_reopened: 'फिर से खोली गई',
    fixed_q: 'ठीक हुई?',
    yes: 'हाँ',
    no: 'नहीं',
    fixed_thanks: 'पुष्टि के लिए धन्यवाद।',
    reopened_toast: 'शिकायत फिर से खोली गई। टीम दोबारा जांच करेगी।',
    pole_eyebrow: 'स्ट्रीटलाइट',
    pole_reported: 'यह पहले से दर्ज है। मरम्मत जारी है।',
    pole_ok: 'कोई ज्ञात समस्या नहीं।',
    pole_shutdown: '{time} तक नियोजित बिजली कटौती के कारण बंद।',
  },
};
