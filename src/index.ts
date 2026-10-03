import * as http from 'node:http';
import { applyProxyFromEnv } from './lib/proxyEnv.js';
import { createProgram } from './program.js';

applyProxyFromEnv({ env: process.env, http });

createProgram().parse();
