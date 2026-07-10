function success(res, msg, data = null, statusCode = 200) {
  const body = { status: "1", msg };
  if (data !== null) body.data = data;
  return res.status(statusCode).json(body);
}

function error(res, msg, statusCode = 400, data = []) {
  return res.status(statusCode).json({
    status: "0",
    msg,
    data,
  });
}

module.exports = { success, error };
