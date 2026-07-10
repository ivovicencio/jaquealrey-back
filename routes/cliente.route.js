const router = require("express").Router();
const clienteCtrl = require("../controllers/cliente.controller");
const { verifyToken } = require("../middlewares/auth.middleware");
const { validate } = require("../middlewares/validator");

const updateClienteSchema = [
  { name: "nombre", type: "string", minLength: 2 },
  { name: "telefono", type: "string", minLength: 6 },
];

router.get("/:id", verifyToken, clienteCtrl.getById);
router.put("/:id", verifyToken, validate(updateClienteSchema), clienteCtrl.update);

module.exports = router;
