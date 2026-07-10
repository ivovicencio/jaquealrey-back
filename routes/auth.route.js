const router = require("express").Router();
const authCtrl = require("../controllers/auth.controller");
const { validate } = require("../middlewares/validator");
const { loginLimiter, registerLimiter } = require("../middlewares/rateLimiter");

const registerSchema = [
  { name: "nombre", type: "string", required: true, minLength: 2 },
  { name: "telefono", type: "string", required: true, minLength: 6 },
  { name: "email", type: "email", required: true },
  { name: "password", type: "string", required: true, minLength: 8 },
];

const loginSchema = [
  { name: "email", type: "email", required: true },
  { name: "password", type: "string", required: true },
];

router.post("/register", registerLimiter, validate(registerSchema), authCtrl.register);
router.post("/login", loginLimiter, validate(loginSchema), authCtrl.login);

module.exports = router;
