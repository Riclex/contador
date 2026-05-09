import { z } from 'zod';

export const WebhookBodySchema = z.object({
  From: z.string().regex(/^whatsapp:\+\d{7,15}$/, 'Invalid phone format'),
  Body: z.string().max(2000, 'Message too long').default(''),
  MessageSid: z.string().optional()
});
