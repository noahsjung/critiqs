/** Whether the deployment sends email: Resend's key and a sender address are both set. */
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.CRITIQS_EMAIL_FROM);
}
