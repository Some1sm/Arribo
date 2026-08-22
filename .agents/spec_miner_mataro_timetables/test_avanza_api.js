const https = require('https');
const querystring = require('querystring');

function postRequest(params) {
  return new Promise((resolve, reject) => {
    const postData = querystring.stringify(params);
    const options = {
      hostname: 'mataro.avanzagrupo.com',
      port: 443,
      path: '/detalle-linea?p_p_id=adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&_adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_cmd=' + params.cmd,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(postData),
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    req.write(postData);
    req.end();
  });
}

async function main() {
  const hRes = await postRequest({
    cmd: 'getHorariosTeoricos',
    _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_idBusLine: '8',
    _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_pathIdBusLine: '11',
    _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_direccion: 'I',
    _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_primeraParada: '1132'
  });
  console.log('Raw hRes for L8 Ida (primeraParada=1132):', hRes);

  const hRes2 = await postRequest({
    cmd: 'getHorariosTeoricos',
    _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_idBusLine: '8',
    _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_pathIdBusLine: '12',
    _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_direccion: 'V',
    _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_primeraParada: '1058'
  });
  console.log('Raw hRes for L8 Vuelta (primeraParada=1058):', hRes2);
}

main().catch(console.error);
