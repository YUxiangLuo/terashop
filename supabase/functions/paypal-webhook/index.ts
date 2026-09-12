/// <reference path="../_shared/deno.d.ts" />
import { handlePayPalWebhook } from './handler.ts';

Deno.serve(handlePayPalWebhook);
