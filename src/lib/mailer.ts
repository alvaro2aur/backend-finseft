export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Aún no hay proveedor de correo: en desarrollo el mensaje (con el enlace) se imprime en consola.
 * En las pruebas se acumula en `outbox`. Para producción, reemplazar `send` por SMTP/API.
 */
export const outbox: Mail[] = [];

export async function send(mail: Mail): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    outbox.push(mail);
    return;
  }
  console.log(`[mail] a ${mail.to}: ${mail.subject}\n${mail.text}`);
}
