/// <reference path="../_shared/deno.d.ts" />
import { handleStripeCreateRefund } from './handler.ts';

Deno.serve(handleStripeCreateRefund);
