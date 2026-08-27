import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

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

export const CHROMIUM = {
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
};
