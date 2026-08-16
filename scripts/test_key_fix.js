const fs = require('fs');

function testFix() {
  const isToday = true;
  const tripKey = `13:00_R_${isToday ? 'today' : 'future'}`;
  console.log('Fixed tripKey:', tripKey);
}

testFix();
