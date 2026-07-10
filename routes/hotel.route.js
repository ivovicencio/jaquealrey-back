const router = require("express").Router();
const hotelCtrl = require("../controllers/hotel.controller");
const { verifyToken, verifyAdmin } = require("../middlewares/auth.middleware");

router.get("/", hotelCtrl.getHotel);
router.put("/", verifyToken, verifyAdmin, hotelCtrl.updateHotel);

module.exports = router;
