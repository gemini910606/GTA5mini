import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { existsSync } from 'node:fs';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml',
};

/** Minimal static file server rooted at `root`. Resolves once listening. */
export async function serve( root, port ) {
  const server = createServer( async ( req, res ) => {
    let path = normalize( decodeURIComponent( new URL( req.url, 'http://localhost' ).pathname ) );
    if ( path === '/' ) path = '/index.html';
    const file = join( root, path );

    if ( ! file.startsWith( root ) ) { res.writeHead( 403 ); res.end(); return; }

    // Read before writing headers, so a miss can still send a clean 404.
    let body;
    try {
      body = await readFile( file );
    } catch {
      res.writeHead( 404, { 'Content-Type': 'text/plain' } );
      res.end( 'not found' );
      return;
    }
    res.writeHead( 200, { 'Content-Type': MIME[ extname( file ) ] ?? 'application/octet-stream' } );
    res.end( body );
  } );

  await new Promise( r => server.listen( port, r ) );
  return server;
}

/**
 * Navigation timeout for every harness here.
 *
 * They all already allow 120s for the game to signal ready, but `page.goto`
 * was left on Playwright's 30s default, which is a different budget for the
 * same slow boot. Under SwiftShader the load event scales with viewport area
 * -- measured 7.8s at 640x360, 14.3s at 1100x620, 19.0s at 1280x720 -- so the
 * widest harness clears 30s on a runner only modestly slower than a dev box,
 * and fails with a bare navigation timeout that reads like a hang rather than
 * like "software rendering is slow". Matching the two budgets removes that.
 */
export const NAV_TIMEOUT = 120000;

/**
 * Launch options for every headless harness here: SwiftShader software GL,
 * because neither the dev container nor a CI runner has a GPU.
 *
 * The executable path is only pinned when that exact build is present. It is
 * right for the dev container and wrong everywhere else, so when it is missing
 * the key is omitted entirely and Playwright resolves the Chromium it
 * installed itself. Set CHROMIUM_PATH to point somewhere else.
 */
const PINNED = process.env.CHROMIUM_PATH
  ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// Without a pinned build, ask for the full browser by channel rather than
// letting Playwright default to chrome-headless-shell: the shell does not give
// the SwiftShader flags below a usable WebGL2 context.
const browser = existsSync( PINNED )
  ? { executablePath: PINNED }
  : { channel: 'chromium' };

export const CHROMIUM = {
  ...browser,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
};
