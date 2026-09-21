/// <reference path="../_shared/deno.d.ts" />
import { handleManagedMedia } from './handler.ts';

Deno.serve(handleManagedMedia);
