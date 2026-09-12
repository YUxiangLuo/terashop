/// <reference path="../_shared/deno.d.ts" />
import { handlePayPalCreateRefund } from './handler.ts';

Deno.serve(handlePayPalCreateRefund);
