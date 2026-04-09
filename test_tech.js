const url = 'http://157.66.36.252:5380/api/dashboard/stats/get?token=d438a047a31cd37506e227566d2759d57fb52c28ac1e0f73addc4ecda4276d8a&type=lastHour';
fetch(url).then(r => r.json()).then(console.log).catch(err => fetch(url).then(r => console.log('/stats/get status:', r.status)));

const url2 = 'http://157.66.36.252:5380/api/dashboard/chart/get?token=d438a047a31cd37506e227566d2759d57fb52c28ac1e0f73addc4ecda4276d8a&type=lastHour';
fetch(url2).then(r => r.json()).then(console.log).catch(err => fetch(url2).then(r => console.log('/chart/get status:', r.status)));
