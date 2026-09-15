import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

export const asyncRoute = (handler: AsyncHandler): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
