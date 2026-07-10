const router = require("express").Router();
const habitacionCtrl = require("../controllers/habitacion.controller");

router.get("/disponibles", habitacionCtrl.getDisponibles);
router.get("/:id", habitacionCtrl.getById);
router.get("/", habitacionCtrl.getAll);

module.exports = router;
