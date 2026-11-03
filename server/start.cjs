// CommonJS entry for hosts whose Node.js launcher loads the app with require() (Hostinger's
// LiteSpeed lsnode). require() cannot load server/index.js, an ES module with top-level await,
// so load it through import() instead.
import('./index.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
