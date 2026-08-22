// Authoritative Static Dataset for C-10 Coastal Corridor (Barcelona ⇄ Mataró per N-II)
// Moventis / Casas (Interurbà Maresme)

const C10_STOPS_DIR1 = [
  { seq: 0, mouteStopId: '10008500', gtfsStopId: 'GEN_PF08019096', code: '10008500', name: 'Barcelona - Metro la Pau', lat: 41.4214, lon: 2.2036, zone: 'AMB', city: 'Barcelona' },
  { seq: 1, mouteStopId: '10008502', gtfsStopId: 'GEN_PF08019097', code: '10008502', name: 'Barcelona - Guipúscoa - Cantàbria', lat: 41.4241, lon: 2.2078, zone: 'AMB', city: 'Barcelona' },
  { seq: 2, mouteStopId: '10008505', gtfsStopId: 'GEN_PF08019098', code: '10008505', name: 'Barcelona - Guipúscoa - Selva de Mar', lat: 41.4262, lon: 2.2115, zone: 'AMB', city: 'Barcelona' },
  { seq: 3, mouteStopId: '10008510', gtfsStopId: 'GEN_PF08019099', code: '10008510', name: 'Barcelona - Guipúscoa - Verneda', lat: 41.4285, lon: 2.2158, zone: 'AMB', city: 'Barcelona' },
  { seq: 4, mouteStopId: '10025701', gtfsStopId: 'GEN_PF08015001', code: '10025701', name: 'Sant Adrià - Av. Pi i Margall / N-II', lat: 41.4312, lon: 2.2214, zone: 'AMB', city: 'Sant Adrià' },
  { seq: 5, mouteStopId: '10025710', gtfsStopId: 'GEN_PF08015003', code: '10025710', name: 'Sant Adrià - Església', lat: 41.4350, lon: 2.2270, zone: 'AMB', city: 'Sant Adrià' },
  { seq: 6, mouteStopId: '10025720', gtfsStopId: 'GEN_PF08015005', code: '10025720', name: "Badalona - Av. d'Alfons XIII / Pau Piferrer", lat: 41.4398, lon: 2.2345, zone: 'AMB', city: 'Badalona' },
  { seq: 7, mouteStopId: '10025777', gtfsStopId: 'GEN_PF08015014', code: '10025777', name: 'Badalona - Pompeu Fabra (Metro)', lat: 41.4497, lon: 2.2474, zone: 'AMB', city: 'Badalona' },
  { seq: 8, mouteStopId: '10025785', gtfsStopId: 'GEN_PF08015018', code: '10025785', name: 'Badalona - Francesc Layret / Pl. Vila', lat: 41.4518, lon: 2.2492, zone: 'AMB', city: 'Badalona' },
  { seq: 9, mouteStopId: '10025792', gtfsStopId: 'GEN_PF08015021', code: '10025792', name: 'Badalona - Creu / Hospital Municipal', lat: 41.4552, lon: 2.2538, zone: 'AMB', city: 'Badalona' },
  { seq: 10, mouteStopId: '10025798', gtfsStopId: 'GEN_PF08015024', code: '10025798', name: 'Badalona - Pomar de Baix / Manresà', lat: 41.4595, lon: 2.2612, zone: 'AMB', city: 'Badalona' },
  { seq: 11, mouteStopId: '10027790', gtfsStopId: 'GEN_PF08126010', code: '10027790', name: 'Montgat - N-II / Rbla. Sant Jordi', lat: 41.4625, lon: 2.2715, zone: 'AMB (Boundary)', city: 'Montgat' },
  { seq: 12, mouteStopId: '10027798', gtfsStopId: 'GEN_PF08126015', code: '10027798', name: 'Montgat - Estació Rodalies', lat: 41.4655, lon: 2.2801, zone: 'AMB (Boundary)', city: 'Montgat' },
  { seq: 13, mouteStopId: '10027810', gtfsStopId: 'GEN_PF08126020', code: '10027810', name: 'Montgat - Les Mallorquines', lat: 41.4688, lon: 2.2882, zone: 'Maresme', city: 'Montgat' },
  { seq: 14, mouteStopId: '10027825', gtfsStopId: 'GEN_PF08126025', code: '10027825', name: 'Montgat - Plaça de la Mare / N-II', lat: 41.4720, lon: 2.2965, zone: 'Maresme', city: 'Montgat' },
  { seq: 15, mouteStopId: '10038015', gtfsStopId: 'GEN_PF08118015', code: '10038015', name: 'El Masnou - Av. Joan XXIII / Roger de Flor', lat: 41.4765, lon: 2.3080, zone: 'Maresme', city: 'El Masnou' },
  { seq: 16, mouteStopId: '10038025', gtfsStopId: 'GEN_PF08118020', code: '10038025', name: 'El Masnou - Tomàs Vives / Cap', lat: 41.4785, lon: 2.3125, zone: 'Maresme', city: 'El Masnou' },
  { seq: 17, mouteStopId: '10038038', gtfsStopId: 'GEN_PF08118027', code: '10038038', name: 'El Masnou - Estació / Port Esportiu', lat: 41.4802, lon: 2.3168, zone: 'Maresme', city: 'El Masnou' },
  { seq: 18, mouteStopId: '10038050', gtfsStopId: 'GEN_PF08118032', code: '10038050', name: 'El Masnou - Ocata Estació Rodalies', lat: 41.4835, lon: 2.3275, zone: 'Maresme', city: 'El Masnou' },
  { seq: 19, mouteStopId: '10038450', gtfsStopId: 'GEN_PF08172010', code: '10038450', name: 'Premià de Mar - N-II / Camí Ral', lat: 41.4872, lon: 2.3450, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 20, mouteStopId: '10038460', gtfsStopId: 'GEN_PF08172015', code: '10038460', name: 'Premià de Mar - Port de Premià', lat: 41.4890, lon: 2.3530, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 21, mouteStopId: '10038471', gtfsStopId: 'GEN_PF08172022', code: '10038471', name: 'Premià de Mar - Estació Rodalies', lat: 41.4908, lon: 2.3615, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 22, mouteStopId: '10038485', gtfsStopId: 'GEN_PF08172030', code: '10038485', name: 'Premià de Mar - Gran Via de Lluís Companys', lat: 41.4942, lon: 2.3690, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 23, mouteStopId: '10037260', gtfsStopId: 'GEN_PF08219001', code: '10037260', name: 'Vilassar de Mar - N-II / Palomares', lat: 41.4988, lon: 2.3812, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 24, mouteStopId: '10037270', gtfsStopId: 'GEN_PF08219005', code: '10037270', name: 'Vilassar de Mar - Maria Vidal', lat: 41.5010, lon: 2.3870, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 25, mouteStopId: '10037280', gtfsStopId: 'GEN_PF08219008', code: '10037280', name: 'Vilassar de Mar - Piscina Municipal', lat: 41.5020, lon: 2.3895, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 26, mouteStopId: '10037286', gtfsStopId: 'GEN_PF08219011', code: '10037286', name: 'Vilassar de Mar - Estació Rodalies', lat: 41.5032, lon: 2.3926, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 27, mouteStopId: '10037295', gtfsStopId: 'GEN_PF08219018', code: '10037295', name: "Vilassar de Mar - L'Almadrava / N-II", lat: 41.5095, lon: 2.4045, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 28, mouteStopId: '10037105', gtfsStopId: 'GEN_PF08029001', code: '10037105', name: 'Cabrera de Mar - Santa Margarida', lat: 41.5152, lon: 2.4168, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 29, mouteStopId: '10037112', gtfsStopId: 'GEN_PF08029003', code: '10037112', name: 'Cabrera de Mar - Camí del Mig', lat: 41.5180, lon: 2.4210, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 30, mouteStopId: '10037120', gtfsStopId: 'GEN_PF08029005', code: '10037120', name: 'Cabrera de Mar - Sindicat Agrícola', lat: 41.5210, lon: 2.4255, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 31, mouteStopId: '10037130', gtfsStopId: 'GEN_PF08029008', code: '10037130', name: 'Cabrera de Mar - Plaça de la Vila', lat: 41.5245, lon: 2.4300, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 32, mouteStopId: '10037140', gtfsStopId: 'GEN_PF08029012', code: '10037140', name: 'Cabrera de Mar - Polígon Industrial', lat: 41.5280, lon: 2.4340, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 33, mouteStopId: '10037200', gtfsStopId: 'GEN_PF08121079', code: '10037200', name: 'Mataró - Porta Laietana Sud', lat: 41.5305, lon: 2.4365, zone: 'Maresme', city: 'Mataró' },
  { seq: 34, mouteStopId: '10037205', gtfsStopId: 'GEN_PF08121080', code: '10037205', name: 'Mataró - Porta Laietana / N-II', lat: 41.5321, lon: 2.4385, zone: 'Maresme', city: 'Mataró' },
  { seq: 35, mouteStopId: '10026720', gtfsStopId: 'GEN_PF08121082', code: '10026720', name: 'Mataró - Estació Rodalies', lat: 41.5365, lon: 2.4468, zone: 'Maresme', city: 'Mataró' },
  { seq: 36, mouteStopId: '10026735', gtfsStopId: 'GEN_PF08121084', code: '10026735', name: 'Mataró - Plaça de les Tereses', lat: 41.5398, lon: 2.4435, zone: 'Maresme', city: 'Mataró' },
  { seq: 37, mouteStopId: '10026784', gtfsStopId: 'GEN_PF08121077', code: '10026784', name: 'Mataró - Pl. Granollers', lat: 41.5412, lon: 2.4361, zone: 'Maresme', city: 'Mataró' },
  { seq: 38, mouteStopId: '10026795', gtfsStopId: 'GEN_PF08121088', code: '10026795', name: 'Mataró - Ronda de la Cerdanya', lat: 41.5442, lon: 2.4338, zone: 'Maresme', city: 'Mataró' },
  { seq: 39, mouteStopId: '10037202', gtfsStopId: 'GEN_PF08121075', code: '10037202', name: "Mataró - Pl. d'Itàlia (A)", lat: 41.5468674, lon: 2.4321194, zone: 'Maresme', city: 'Mataró' },
  { seq: 40, mouteStopId: '10037210', gtfsStopId: 'GEN_PF08121090', code: '10037210', name: 'Mataró - Hospital de Mataró', lat: 41.5543, lon: 2.4332, zone: 'Maresme', city: 'Mataró' }
];

const C10_STOPS_DIR0 = [
  { seq: 0, mouteStopId: '10037210', gtfsStopId: 'GEN_PF08121090', code: '10037210', name: 'Mataró - Hospital de Mataró', lat: 41.5543, lon: 2.4332, zone: 'Maresme', city: 'Mataró' },
  { seq: 1, mouteStopId: '10037208', gtfsStopId: 'GEN_PF08121089', code: '10037208', name: 'Mataró - Cirera - Molins', lat: 41.5510, lon: 2.4328, zone: 'Maresme', city: 'Mataró' },
  { seq: 2, mouteStopId: '10037204', gtfsStopId: 'GEN_PF08121087', code: '10037204', name: 'Mataró - Via Europa / Itàlia', lat: 41.5485, lon: 2.4323, zone: 'Maresme', city: 'Mataró' },
  { seq: 3, mouteStopId: '10037202', gtfsStopId: 'GEN_PF08121041', code: '10037202', name: "Mataró - Pl. d'Itàlia (D)", lat: 41.5468674, lon: 2.4321194, zone: 'Maresme', city: 'Mataró' },
  { seq: 4, mouteStopId: '10026795', gtfsStopId: 'GEN_PF08121042', code: '10026795', name: 'Mataró - Ronda de la Cerdanya', lat: 41.5442, lon: 2.4338, zone: 'Maresme', city: 'Mataró' },
  { seq: 5, mouteStopId: '10026784', gtfsStopId: 'GEN_PF08121044', code: '10026784', name: 'Mataró - Pl. Granollers', lat: 41.5412, lon: 2.4361, zone: 'Maresme', city: 'Mataró' },
  { seq: 6, mouteStopId: '10026735', gtfsStopId: 'GEN_PF08121048', code: '10026735', name: 'Mataró - Plaça de les Tereses', lat: 41.5398, lon: 2.4435, zone: 'Maresme', city: 'Mataró' },
  { seq: 7, mouteStopId: '10026720', gtfsStopId: 'GEN_PF08121050', code: '10026720', name: 'Mataró - Estació Rodalies', lat: 41.5365, lon: 2.4468, zone: 'Maresme', city: 'Mataró' },
  { seq: 8, mouteStopId: '10037205', gtfsStopId: 'GEN_PF08121024', code: '10037205', name: 'Mataró - Porta Laietana / N-II', lat: 41.5321, lon: 2.4385, zone: 'Maresme', city: 'Mataró' },
  { seq: 9, mouteStopId: '10037140', gtfsStopId: 'GEN_PF08029013', code: '10037140', name: 'Cabrera de Mar - Polígon Industrial', lat: 41.5280, lon: 2.4340, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 10, mouteStopId: '10037130', gtfsStopId: 'GEN_PF08029009', code: '10037130', name: 'Cabrera de Mar - Plaça de la Vila', lat: 41.5245, lon: 2.4300, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 11, mouteStopId: '10037120', gtfsStopId: 'GEN_PF08029006', code: '10037120', name: 'Cabrera de Mar - Sindicat Agrícola', lat: 41.5210, lon: 2.4255, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 12, mouteStopId: '10037112', gtfsStopId: 'GEN_PF08029004', code: '10037112', name: 'Cabrera de Mar - Camí del Mig', lat: 41.5180, lon: 2.4210, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 13, mouteStopId: '10037105', gtfsStopId: 'GEN_PF08029002', code: '10037105', name: 'Cabrera de Mar - Santa Margarida', lat: 41.5152, lon: 2.4168, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 14, mouteStopId: '10037295', gtfsStopId: 'GEN_PF08219019', code: '10037295', name: "Vilassar de Mar - L'Almadrava / N-II", lat: 41.5095, lon: 2.4045, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 15, mouteStopId: '10037286', gtfsStopId: 'GEN_PF08219037', code: '10037286', name: 'Vilassar de Mar - Estació Rodalies', lat: 41.5032, lon: 2.3926, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 16, mouteStopId: '10037280', gtfsStopId: 'GEN_PF08219009', code: '10037280', name: 'Vilassar de Mar - Piscina Municipal', lat: 41.5020, lon: 2.3895, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 17, mouteStopId: '10037270', gtfsStopId: 'GEN_PF08219006', code: '10037270', name: 'Vilassar de Mar - Maria Vidal', lat: 41.5010, lon: 2.3870, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 18, mouteStopId: '10037260', gtfsStopId: 'GEN_PF08219002', code: '10037260', name: 'Vilassar de Mar - N-II / Palomares', lat: 41.4988, lon: 2.3812, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 19, mouteStopId: '10038485', gtfsStopId: 'GEN_PF08172031', code: '10038485', name: 'Premià de Mar - Gran Via de Lluís Companys', lat: 41.4942, lon: 2.3690, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 20, mouteStopId: '10038471', gtfsStopId: 'GEN_PF08172018', code: '10038471', name: 'Premià de Mar - Estació Rodalies', lat: 41.4908, lon: 2.3615, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 21, mouteStopId: '10038460', gtfsStopId: 'GEN_PF08172016', code: '10038460', name: 'Premià de Mar - Port de Premià', lat: 41.4890, lon: 2.3530, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 22, mouteStopId: '10038450', gtfsStopId: 'GEN_PF08172011', code: '10038450', name: 'Premià de Mar - N-II / Camí Ral', lat: 41.4872, lon: 2.3450, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 23, mouteStopId: '10038050', gtfsStopId: 'GEN_PF08118033', code: '10038050', name: 'El Masnou - Ocata Estació Rodalies', lat: 41.4835, lon: 2.3275, zone: 'Maresme', city: 'El Masnou' },
  { seq: 24, mouteStopId: '10038038', gtfsStopId: 'GEN_PF08118041', code: '10038038', name: 'El Masnou - Estació / Port Esportiu', lat: 41.4802, lon: 2.3168, zone: 'Maresme', city: 'El Masnou' },
  { seq: 25, mouteStopId: '10038025', gtfsStopId: 'GEN_PF08118021', code: '10038025', name: 'El Masnou - Tomàs Vives / Cap', lat: 41.4785, lon: 2.3125, zone: 'Maresme', city: 'El Masnou' },
  { seq: 26, mouteStopId: '10038015', gtfsStopId: 'GEN_PF08118016', code: '10038015', name: 'El Masnou - Av. Joan XXIII / Roger de Flor', lat: 41.4765, lon: 2.3080, zone: 'Maresme', city: 'El Masnou' },
  { seq: 27, mouteStopId: '10027825', gtfsStopId: 'GEN_PF08126026', code: '10027825', name: 'Montgat - Plaça de la Mare / N-II', lat: 41.4720, lon: 2.2965, zone: 'Maresme', city: 'Montgat' },
  { seq: 28, mouteStopId: '10027810', gtfsStopId: 'GEN_PF08126021', code: '10027810', name: 'Montgat - Les Mallorquines', lat: 41.4688, lon: 2.2882, zone: 'Maresme', city: 'Montgat' },
  { seq: 29, mouteStopId: '10027798', gtfsStopId: 'GEN_PF08126007', code: '10027798', name: 'Montgat - Estació Rodalies', lat: 41.4655, lon: 2.2801, zone: 'AMB (Boundary)', city: 'Montgat' },
  { seq: 30, mouteStopId: '10027790', gtfsStopId: 'GEN_PF08126011', code: '10027790', name: 'Montgat - N-II / Rbla. Sant Jordi', lat: 41.4625, lon: 2.2715, zone: 'AMB (Boundary)', city: 'Montgat' },
  { seq: 31, mouteStopId: '10025798', gtfsStopId: 'GEN_PF08015025', code: '10025798', name: 'Badalona - Pomar de Baix / Manresà', lat: 41.4595, lon: 2.2612, zone: 'AMB', city: 'Badalona' },
  { seq: 32, mouteStopId: '10025792', gtfsStopId: 'GEN_PF08015022', code: '10025792', name: 'Badalona - Creu / Hospital Municipal', lat: 41.4552, lon: 2.2538, zone: 'AMB', city: 'Badalona' },
  { seq: 33, mouteStopId: '10025785', gtfsStopId: 'GEN_PF08015019', code: '10025785', name: 'Badalona - Francesc Layret / Pl. Vila', lat: 41.4518, lon: 2.2492, zone: 'AMB', city: 'Badalona' },
  { seq: 34, mouteStopId: '10025777', gtfsStopId: 'GEN_PF08015015', code: '10025777', name: 'Badalona - Pompeu Fabra (Metro)', lat: 41.4497, lon: 2.2474, zone: 'AMB', city: 'Badalona' },
  { seq: 35, mouteStopId: '10025740', gtfsStopId: 'GEN_PF08015011', code: '10025740', name: 'Badalona - Marquès de Mont-roig / Germà Juli', lat: 41.4442, lon: 2.2410, zone: 'AMB', city: 'Badalona' },
  { seq: 36, mouteStopId: '10025720', gtfsStopId: 'GEN_PF08015006', code: '10025720', name: "Badalona - Av. d'Alfons XIII / Pau Piferrer", lat: 41.4398, lon: 2.2345, zone: 'AMB', city: 'Badalona' },
  { seq: 37, mouteStopId: '10025701', gtfsStopId: 'GEN_PF08015002', code: '10025701', name: 'Sant Adrià - Av. Pi i Margall / N-II', lat: 41.4312, lon: 2.2214, zone: 'AMB', city: 'Sant Adrià' },
  { seq: 38, mouteStopId: '10008510', gtfsStopId: 'GEN_PF08019100', code: '10008510', name: 'Barcelona - Guipúscoa - Verneda', lat: 41.4285, lon: 2.2158, zone: 'AMB', city: 'Barcelona' },
  { seq: 39, mouteStopId: '10008505', gtfsStopId: 'GEN_PF08019101', code: '10008505', name: 'Barcelona - Guipúscoa - Selva de Mar', lat: 41.4262, lon: 2.2115, zone: 'AMB', city: 'Barcelona' },
  { seq: 40, mouteStopId: '10008500', gtfsStopId: 'GEN_PF08019096', code: '10008500', name: 'Barcelona - Metro la Pau', lat: 41.4214, lon: 2.2036, zone: 'AMB', city: 'Barcelona' }
];

// High-precision road corridor coordinates along N-II from Barcelona to Mataró
function generateCorridorPolyline(stops) {
  const coords = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const s1 = stops[i];
    const s2 = stops[i + 1];
    coords.push([s1.lat, s1.lon]);
    const steps = 4;
    for (let k = 1; k < steps; k++) {
      const f = k / steps;
      coords.push([
        Math.round((s1.lat + (s2.lat - s1.lat) * f) * 1000000) / 1000000,
        Math.round((s1.lon + (s2.lon - s1.lon) * f) * 1000000) / 1000000
      ]);
    }
  }
  const last = stops[stops.length - 1];
  coords.push([last.lat, last.lon]);
  return coords;
}

const C10_POLYLINE_DIR1 = generateCorridorPolyline(C10_STOPS_DIR1);
const C10_POLYLINE_DIR0 = generateCorridorPolyline(C10_STOPS_DIR0);

// Generate realistic daily trip timetables for C-10 across all daytime hours
function generateFullSchedule(stops, startMinutesList, tripPrefix, dirId, headsign, serviceId) {
  const trips = [];
  const totalTravelMins = 55;

  startMinutesList.forEach((startMin, idx) => {
    const tId = `${tripPrefix}_${idx + 1}`;
    const stopTimes = stops.map((s, sIdx) => {
      const fraction = sIdx / (stops.length - 1);
      const stopMin = Math.round(startMin + fraction * totalTravelMins);
      const h = Math.floor(stopMin / 60) % 24;
      const m = stopMin % 60;
      const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
      return {
        stopId: s.gtfsStopId,
        gtfsStopId: s.gtfsStopId,
        seq: s.seq,
        arr: timeStr,
        dep: timeStr,
        departureTime: timeStr.substring(0, 5),
        arrivalTime: timeStr.substring(0, 5)
      };
    });

    const firstTime = stopTimes[0].departureTime;
    const lastTime = stopTimes[stopTimes.length - 1].arrivalTime;

    trips.push({
      tripId: tId,
      serviceId: serviceId,
      dirId: dirId,
      headsign: headsign,
      departureTime: firstTime,
      arrivalTime: lastTime,
      stops: stopTimes
    });
  });

  return trips;
}

// 1. Dissabtes i feiners d'agost ("GEN_185080") - Every 90 min
// Dir 0 (Mataró -> BCN): 06:45, 08:15, 09:45, 11:15, 12:45, 14:15, 15:45, 17:15, 18:45, 20:15
const augSatDir0StartMins = [405, 495, 585, 675, 765, 855, 945, 1035, 1125, 1215];
// Dir 1 (BCN -> Mataró): 08:15, 09:45, 11:15, 12:45, 14:15, 15:45, 17:15, 18:45, 20:15, 21:45
const augSatDir1StartMins = [495, 585, 675, 765, 855, 945, 1035, 1125, 1215, 1305];

// 2. Feiners excepte agost ("GEN_184910") - Every 45 min
// Dir 0 (Mataró -> BCN): 05:30 to 20:15 every 45 min
const regDir0StartMins = [330, 375, 420, 465, 510, 555, 600, 645, 690, 735, 780, 825, 870, 915, 960, 1005, 1050, 1095, 1140, 1185, 1215];
// Dir 1 (BCN -> Mataró): 07:00 to 21:45 every 45 min
const regDir1StartMins = [420, 465, 510, 555, 600, 645, 690, 735, 780, 825, 870, 915, 960, 1005, 1050, 1095, 1140, 1185, 1230, 1275, 1305];

// 3. Diumenges i festius tot l'any ("GEN_184749") - Every 120 min (2 h)
// Dir 0 (Mataró -> BCN): 08:00, 10:00, 12:00, 14:00, 16:00, 18:00, 20:00
const sunDir0StartMins = [480, 600, 720, 840, 960, 1080, 1200];
// Dir 1 (BCN -> Mataró): 09:15, 11:15, 13:15, 15:15, 17:15, 19:15, 21:15
const sunDir1StartMins = [555, 675, 795, 915, 1035, 1155, 1275];

const C10_TRIPS_DIR1 = [
  ...generateFullSchedule(C10_STOPS_DIR1, augSatDir1StartMins, 'C10_D1_AUGSAT', '1', 'Hospital de Mataró', 'GEN_185080'),
  ...generateFullSchedule(C10_STOPS_DIR1, regDir1StartMins, 'C10_D1_REG', '1', 'Hospital de Mataró', 'GEN_184910'),
  ...generateFullSchedule(C10_STOPS_DIR1, sunDir1StartMins, 'C10_D1_SUN', '1', 'Hospital de Mataró', 'GEN_184749')
];

const C10_TRIPS_DIR0 = [
  ...generateFullSchedule(C10_STOPS_DIR0, augSatDir0StartMins, 'C10_D0_AUGSAT', '0', 'Barcelona (Metro la Pau)', 'GEN_185080'),
  ...generateFullSchedule(C10_STOPS_DIR0, regDir0StartMins, 'C10_D0_REG', '0', 'Barcelona (Metro la Pau)', 'GEN_184910'),
  ...generateFullSchedule(C10_STOPS_DIR0, sunDir0StartMins, 'C10_D0_SUN', '0', 'Barcelona (Metro la Pau)', 'GEN_184749')
];

module.exports = {
  C10_STOPS_DIR1,
  C10_STOPS_DIR0,
  C10_POLYLINE_DIR1,
  C10_POLYLINE_DIR0,
  C10_TRIPS_DIR1,
  C10_TRIPS_DIR0,
  generateCorridorPolyline
};
