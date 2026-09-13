/// <reference path="../_shared/deno.d.ts" />
import { handlePayPalReconcileCaptures } from './handler.ts';

Deno.serve(handlePayPalReconcileCaptures);
