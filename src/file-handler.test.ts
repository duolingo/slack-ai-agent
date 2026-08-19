jest.mock("./config", () => ({
  config: { slack: { botToken: "test" } },
}));

import path from "path";
import { getUploadPath } from "./file-handler";

it("keeps upload names inside the thread workspace", () => {
  const workspace = "/tmp/thread-workspace";
  const uploadPath = getUploadPath(workspace, "../../other-thread/file.png");

  expect(path.dirname(uploadPath)).toBe(workspace);
  expect(path.basename(uploadPath)).toMatch(/-file\.png$/);
});
