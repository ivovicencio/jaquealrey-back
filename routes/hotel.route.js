const router = require("express").Router();
const hotelCtrl = require("../controllers/hotel.controller");
const { verifyToken, verifyAdmin } = require("../middlewares/auth.middleware");
const { adminLimiter } = require("../middlewares/rateLimiter");

router.get("/", hotelCtrl.getHotel);
router.put("/", verifyToken, verifyAdmin, adminLimiter, hotelCtrl.updateHotel);

module.exports = router;
