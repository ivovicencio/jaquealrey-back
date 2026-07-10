const router = require("express").Router();
const authCtrl = require("../controllers/auth.controller");
const { verifyToken } = require("../middlewares/auth.middleware");
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

const changePasswordSchema = [
  { name: "password_actual", type: "string", required: true },
  { name: "password_nueva", type: "string", required: true, minLength: 8 },
];

router.post("/register", registerLimiter, validate(registerSchema), authCtrl.register);
router.post("/login", loginLimiter, validate(loginSchema), authCtrl.login);
router.put("/password", verifyToken, validate(changePasswordSchema), authCtrl.changePassword);

module.exports = router;
