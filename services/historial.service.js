/**
 * Historial de cambios (bitacora).
 *
 * La tabla `HistorialReserva` es de solo insercion: nadie la modifica ni la
 * borra desde la aplicacion. Es el registro que sirve para reconstruir que paso
 * con una reserva.
 */

const { executeQuery, ROL } = require("../db");

async function listar({ pagina = 1, limite = 50 }) {
  const paginaNum = Math.max(1, parseInt(pagina, 10) || 1);
  const limiteNum = Math.min(200, Math.max(1, parseInt(limite, 10) || 50));
  const offset = (paginaNum - 1) * limiteNum;

  const total = await executeQuery("SELECT COUNT(*)::int FROM HistorialReserva", [], ROL.ADMIN);

  const result = await executeQuery(
    `SELECT h.*, r.codigo as reserva_codigo
     FROM HistorialReserva h
     JOIN Reserva r ON h.reserva_id = r.id
     ORDER BY h.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limiteNum, offset],
    ROL.ADMIN
  );

  return {
    historial: result.rows,
    total: total.rows[0].count,
    pagina: paginaNum,
    total_paginas: Math.max(1, Math.ceil(total.rows[0].count / limiteNum)),
  };
}

module.exports = { listar };
