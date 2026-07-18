import { Router, type IRouter } from "express";
import healthRouter from "./health";
import analysesRouter from "./analyses";
import noaaRouter from "./noaa";
import draftRouter from "./draft";
import briefingsRouter from "./briefings";
import externalProxyRouter from "./external-proxy";
import synergieRouter from "./synergie";

const router: IRouter = Router();

router.use(healthRouter);
router.use(analysesRouter);
router.use(noaaRouter);
router.use(draftRouter);
router.use(briefingsRouter);
router.use(externalProxyRouter);
router.use(synergieRouter);

export default router;
