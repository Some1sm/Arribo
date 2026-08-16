const now = new Date();
console.log('now.toString():', now.toString());
console.log('now.getHours():', now.getHours());
console.log('now.getTimezoneOffset():', now.getTimezoneOffset());
console.log('Intl.DateTimeFormat().resolvedOptions().timeZone:', Intl.DateTimeFormat().resolvedOptions().timeZone);
