const mouteClient = require('../src/mouteClient');

(async () => {
  console.log('1. Rodalies Mataró:');
  const d1 = await mouteClient.getNextDepartures('10037210', true);
  console.log('Parada:', d1.parada);
  console.log('Sortides count:', d1.sortides?.length);
  if (d1.sortides?.length > 0) {
    console.log('First 3 sortides:', JSON.stringify(d1.sortides.slice(0, 3), null, 2));
  }

  console.log('\n2. Badalona Pompeu Fabra:');
  const d2 = await mouteClient.getNextDepartures('10025777', true);
  console.log('Parada:', d2.parada);
  console.log('Sortides count:', d2.sortides?.length);
  if (d2.sortides?.length > 0) {
    console.log('First 3 sortides:', JSON.stringify(d2.sortides.slice(0, 3), null, 2));
  }
})();
