/// <reference path="../_shared/deno.d.ts" />
import { handlePayPalReconcileRefunds } from './handler.ts';

Deno.serve(handlePayPalReconcileRefunds);
