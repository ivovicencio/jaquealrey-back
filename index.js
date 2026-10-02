/**
 * Punto de entrada.
 *
 * No hace nada: delega en server.js, que es quien levanta el puerto, enchufa
 * Socket.IO y maneja el cierre ordenado. Se mantiene este archivo porque es lo
 * que referencian package.json (`npm start`) y vercel.json.
 */

module.exports = require("./server");
