/// <reference path="../_shared/deno.d.ts" />
import { handlePayPalCreateOrder } from './handler.ts';

Deno.serve(handlePayPalCreateOrder);
