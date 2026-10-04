const router = require("express").Router();
const authCtrl = require("../controllers/auth.controller");
const { verifyAdminToken } = require("../middlewares/auth.middleware");
const { validate } = require("../middlewares/validator");
const { loginLimiter, registerLimiter, loginLockout } = require("../middlewares/rateLimiter");

const registerSchema = [
  { name: "nombre", type: "string", required: true, minLength: 2, maxLength: 80 },
  { name: "apellido", type: "string", maxLength: 80 },
  { name: "telefono", type: "string", required: true, minLength: 6, maxLength: 30 },
  { name: "email", type: "email", required: true },
  { name: "password", type: "string", required: true, minLength: 8, maxLength: 72 },
  { name: "admin_secret", type: "string", required: true, minLength: 8, maxLength: 200 },
];

const loginSchema = [
  { name: "email", type: "email", required: true },
  { name: "password", type: "string", required: true, maxLength: 72 },
];

const changePasswordSchema = [
  { name: "password_actual", type: "string", required: true, maxLength: 72 },
  { name: "password_nueva", type: "string", required: true, minLength: 8, maxLength: 72 },
];

router.post("/register", registerLimiter, validate(registerSchema), authCtrl.register);
router.post("/login", loginLockout, loginLimiter, validate(loginSchema), authCtrl.login);
router.post("/logout", verifyAdminToken, authCtrl.logout);
router.put("/password", verifyAdminToken, validate(changePasswordSchema), authCtrl.changePassword);

module.exports = router;
