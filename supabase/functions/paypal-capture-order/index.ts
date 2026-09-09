/// <reference path="../_shared/deno.d.ts" />
import { handlePayPalCaptureOrder } from './handler.ts';

Deno.serve(handlePayPalCaptureOrder);
