import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Heading } from "@astryxdesign/core/Heading";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { CatalogLoadFailure } from "#src/lib/extensions";

/**
 * The two screens either side of the extension catalog's one fetch.
 *
 * The editor cannot draw a workflow before it knows what a workflow can do, so
 * the boot waits on that request. These are what the wait and its failure look
 * like; without them a cold server paints a blank document, and a failure paints
 * an editor that looks healthy and offers nothing.
 */
export function CatalogLoading() {
  return (
    <Center height="100dvh">
      <Spinner label="Loading editor" />
    </Center>
  );
}

/** What each failure means for the person reading it. */
const FAILURE_SENTENCES: Record<CatalogLoadFailure, string> = {
  unreachable:
    "The server did not answer. It may be down, or something between the browser and it is dropping the request.",
  refused:
    "The server answered with an error. Check that Workflow Graph is mounted where this page expects it.",
  mismatch:
    "The server answered with a document this editor cannot read. The two are most likely different builds of Workflow Graph.",
};

export function CatalogUnavailable({
  endpoint,
  reason,
}: {
  endpoint: string;
  reason: CatalogLoadFailure;
}) {
  return (
    <Center height="100dvh" padding={6}>
      <Card maxWidth={448} padding={6}>
        <VStack gap={3}>
          <Heading level={1}>The editor cannot start</Heading>
          <Text color="secondary">{FAILURE_SENTENCES[reason]}</Text>
          <Text color="secondary">
            It asks GET {endpoint} for the Events, actions and integrations this
            server carries.
          </Text>
          <Button
            label="Try again"
            onClick={() => window.location.reload()}
            size="sm"
            variant="secondary"
          />
        </VStack>
      </Card>
    </Center>
  );
}
