// Escribe openapi.json en la raíz. Una prueba comprueba que esté al día con el código.
import { writeFileSync } from 'node:fs';
import { buildOpenApi } from '../src/openapi/document.ts';

writeFileSync(new URL('../openapi.json', import.meta.url), JSON.stringify(buildOpenApi(), null, 2) + '\n');
console.log('openapi.json actualizado');
