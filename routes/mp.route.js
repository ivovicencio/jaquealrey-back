const router = require("express").Router();
const mpCtrl = require("../controllers/mp.controller");
const { verifyToken } = require("../middlewares/auth.middleware");

router.post("/crear-preferencia", verifyToken, mpCtrl.createPreference);
router.post("/webhook", mpCtrl.webhook);
router.get("/success", mpCtrl.success);
router.get("/pending", mpCtrl.pending);
router.get("/failure", mpCtrl.failure);

module.exports = router;
