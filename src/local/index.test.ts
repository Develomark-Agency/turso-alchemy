import { expect, test } from "bun:test";
import { selectLocalPort } from "./index";

test("selectLocalPort rejects an invalid requested port", async () => {
  await expect(selectLocalPort(0)).rejects.toThrow(
    "Local libSQL server port must be an integer from 1 to 65535"
  );
});
