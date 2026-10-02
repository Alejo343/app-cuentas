// Genera el APK firmado y lo deja en la carpeta apk/
// Uso:  npm run apk
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const { version } = require(path.join(raiz, 'package.json'));
const correr = (cmd, cwd = raiz) => execSync(cmd, { cwd, stdio: 'inherit' });

if (!fs.existsSync(path.join(raiz, 'firma', 'firma.properties'))) {
  console.error('Falta firma/firma.properties: sin la llave no se puede firmar el APK.');
  process.exit(1);
}

correr('npx cap sync android');
const android = path.join(raiz, 'android');
const gradlew = path.join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
correr(`"${gradlew}" assembleRelease`, android);

const origen = path.join(raiz, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const destino = path.join(raiz, 'apk', `MisCuentas-${version}.apk`);
fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.copyFileSync(origen, destino);
console.log(`\nAPK listo: ${destino}`);
