const fs = require('fs');

const lineas = JSON.parse(fs.readFileSync('data/mataro_lineas.json', 'utf8'));
console.log('Lineas keys:', Object.keys(lineas));
console.log('Lineas sample:', JSON.stringify(lineas, null, 2).substring(0, 800));

const paradas = JSON.parse(fs.readFileSync('data/mataro_paradas.json', 'utf8'));
console.log('\nParadas keys:', Object.keys(paradas));
console.log('Paradas count:', Array.isArray(paradas) ? paradas.length : (paradas.paradas ? paradas.paradas.length : 0));
console.log('Paradas sample:', JSON.stringify(paradas, null, 2).substring(0, 800));

const trayectos = JSON.parse(fs.readFileSync('data/mataro_trayectos.json', 'utf8'));
console.log('\nTrayectos keys:', Object.keys(trayectos));
console.log('Trayectos sample:', JSON.stringify(trayectos, null, 2).substring(0, 1200));
