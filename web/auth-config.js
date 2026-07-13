// auth-config.js — the stable import point for the login config used by home.js, lobby.js and the
// game pages. The actual values now come from config.js, which DERIVES them from wherever the client
// is served — so no host, realm URL or tailnet name is baked into the shipped bundle. See config.js
// for how to point a deployment elsewhere (or disable login) without editing source.
import { authConfig } from './config.js';

export const AUTH = authConfig();
