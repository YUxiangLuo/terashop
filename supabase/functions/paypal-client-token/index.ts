/// <reference path="../_shared/deno.d.ts" />
import { handlePayPalClientToken } from './handler.ts';

Deno.serve(handlePayPalClientToken);
