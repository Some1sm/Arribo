const fs = require('fs');
const corridorTracker = require('../src/corridorTracker');

const data = { sortides: { sortida: [] } };
const res = corridorTracker.parseDepartures(data, 'GEN_PF08015093', '1', '10025777', 7);
console.log('Result of empty sortides for 10025777:', res);
