import { Plus, X } from "lucide-react";
import { useId, useMemo } from "react";
import { toast } from "sonner";
import { Button } from "#src/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "#src/components/ui/combobox";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#src/components/ui/select";
import { whenChosen } from "#src/lib/select-choice";
import { generateId } from "@wfgraph/shared/utils/id";
import { ConfigGroup } from "./config-section";
import {
  browserTimeZone,
  cronForPreset,
  isValidRow,
  matchesTimeZone,
  parseTimeInput,
  SCHEDULE_PRESETS,
  type ScheduleRefusal,
  type ScheduleRow,
  scheduleReadout,
  type SchedulePreset,
  timeInputValue,
  timeZoneChoices,
  WEEKDAYS,
  withPreset,
  withPresetFields,
  readWeekday,
} from "./lifecycle-schedule";
import type { ScheduleEditor } from "./use-lifecycle-rules-editor";

/** How many upcoming fire times each schedule lists. */
const READOUT_FIRES = 3;

/**
 * The Schedule group: the clocks that start a run. Each schedule is a preset
 * or a cron expression with its own time zone, and reads back as a sentence
 * with its next fire times. A refused edit stays in the rows unsaved; the
 * caller shows `schedules.refusal` where it shows the panel's other refusals.
 */
export function LifecycleScheduleGroup({
  schedules,
  disabled,
}: {
  schedules: ScheduleEditor;
  disabled: boolean;
}) {
  const { rows, refusal, setRows, stored } = schedules;
  const zones = useMemo(
    () => timeZoneChoices(rows.map((row) => row.timeZone)),
    [rows]
  );
  const now = new Date();

  const replaceRow = (index: number, next: ScheduleRow) =>
    setRows(rows.map((row, at) => (at === index ? next : row)));

  return (
    <ConfigGroup
      className="py-3 first:pt-0 last:pb-0"
      help={
        <>
          <p>
            A schedule starts a run at each time it names, in its time zone.
          </p>
          <p>A scheduled run includes no Event data.</p>
          <p>A workflow that tracks an Entity can't have a schedule.</p>
        </>
      }
      label="Schedule"
      prominent
    >
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">
          Schedules start runs of the published version. Changes take effect
          when you publish.
        </p>
        {rows.map((row, index) => (
          <ScheduleCard
            disabled={disabled}
            invalidField={
              refusal?.rowIndex === index ? refusal.field : undefined
            }
            key={row.id}
            now={now}
            number={index + 1}
            onChange={(next) => replaceRow(index, next)}
            onRemove={() => {
              setRows(rows.filter((_, at) => at !== index));
              // Undo restores what was saved, so only a saved schedule says so.
              if (
                stored.some(
                  (schedule) =>
                    schedule.cron === row.cron &&
                    schedule.timeZone === row.timeZone
                )
              ) {
                toast("Schedule removed", {
                  description: "Use Actions > Undo to restore it.",
                });
              }
            }}
            row={row}
            zones={zones}
          />
        ))}
        <Button
          disabled={disabled}
          onClick={() =>
            setRows([
              ...rows,
              {
                id: generateId(),
                preset: "daily",
                cron: cronForPreset({ preset: "daily" }),
                timeZone: browserTimeZone(),
              },
            ])
          }
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus data-icon="inline-start" />
          Add schedule
        </Button>
      </div>
    </ConfigGroup>
  );
}

function ScheduleCard({
  row,
  number,
  now,
  zones,
  invalidField,
  disabled,
  onChange,
  onRemove,
}: {
  row: ScheduleRow;
  /** The row's place in the list, counted from 1, which names its controls. */
  number: number;
  now: Date;
  zones: readonly string[];
  invalidField: ScheduleRefusal["field"];
  disabled: boolean;
  onChange: (next: ScheduleRow) => void;
  onRemove: () => void;
}) {
  const valid = isValidRow(row);
  const readout = valid ? scheduleReadout(row, now, READOUT_FIRES) : undefined;
  const title = `Schedule ${number}`;

  return (
    <fieldset aria-label={title} className="min-w-0 rounded-md border">
      <div className="flex min-h-9 items-start justify-between gap-2 px-3 py-1.5">
        <p className="min-w-0 break-words pt-1 font-medium text-sm">
          {readout?.description ?? title}
        </p>
        <Button
          aria-label={`Remove ${title.toLowerCase()}`}
          className="shrink-0"
          disabled={disabled}
          onClick={onRemove}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="space-y-2 border-t px-3 py-2">
        <ScheduleTiming
          disabled={disabled}
          invalid={invalidField === "cron"}
          onChange={onChange}
          row={row}
        />
        <TimeZoneField
          disabled={disabled}
          invalid={invalidField === "timeZone"}
          onChange={(timeZone) => onChange({ ...row, timeZone })}
          value={row.timeZone}
          zones={zones}
        />
        {readout && readout.nextFires.length > 0 ? (
          <p className="text-muted-foreground text-xs tabular-nums">
            Next: {readout.nextFires.join("; ")}.
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}

/** The preset picker and the fields the chosen preset asks for. */
function ScheduleTiming({
  row,
  invalid,
  disabled,
  onChange,
}: {
  row: ScheduleRow;
  invalid: boolean;
  disabled: boolean;
  onChange: (next: ScheduleRow) => void;
}) {
  const cronId = useId();
  const cronHelpId = useId();
  const needsTime = row.preset !== "hourly" && row.preset !== "custom";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          disabled={disabled}
          items={SCHEDULE_PRESETS.map((preset) => ({
            label: preset.label,
            value: preset.value,
          }))}
          onValueChange={whenChosen((value) => {
            const preset = readPreset(value);
            if (preset) {
              onChange(withPreset(row, preset));
            }
          })}
          value={row.preset}
        >
          <SelectTrigger aria-label="Repeats" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_PRESETS.map((preset) => (
              <SelectItem key={preset.value} value={preset.value}>
                {preset.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {row.preset === "weekly" ? (
          <>
            <Select
              disabled={disabled}
              items={WEEKDAYS}
              onValueChange={whenChosen((weekday) =>
                onChange(withPresetFields(row, { weekday }))
              )}
              value={readWeekday(row.cron) ?? null}
            >
              <SelectTrigger aria-label="Day" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKDAYS.map((day) => (
                  <SelectItem key={day.value} value={day.value}>
                    {day.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground text-xs">at</span>
          </>
        ) : null}
        {needsTime ? (
          // Wider below md, where an input's text is 16px and the narrower
          // field clips the AM/PM half of the time.
          <Input
            aria-label="Time"
            className="w-36 md:w-28"
            disabled={disabled}
            onChange={(event) => {
              const time = parseTimeInput(event.target.value);
              // A cleared time input reads as blank; the stored time stands
              // until the builder enters another.
              if (time) {
                onChange(withPresetFields(row, { time }));
              }
            }}
            type="time"
            value={timeInputValue(row.cron)}
          />
        ) : null}
      </div>
      {row.preset === "custom" ? (
        <div className="space-y-1">
          <Label htmlFor={cronId}>Cron expression</Label>
          <Input
            aria-describedby={cronHelpId}
            aria-invalid={invalid || undefined}
            autoComplete="off"
            className="font-mono"
            disabled={disabled}
            id={cronId}
            onChange={(event) => onChange({ ...row, cron: event.target.value })}
            placeholder="0 9 * * 1-5"
            spellCheck={false}
            value={row.cron}
          />
          <p className="text-muted-foreground text-xs" id={cronHelpId}>
            Five fields: minute, hour, day of month, month, and day of week.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The preset a Select handed back, or nothing for a value the list does not
 * declare. Base UI types its answer as a plain string.
 */
function readPreset(value: string): SchedulePreset | undefined {
  return SCHEDULE_PRESETS.find((preset) => preset.value === value)?.value;
}

/** A searchable list of every IANA zone, since a schedule may name any of them. */
function TimeZoneField({
  value,
  zones,
  invalid,
  disabled,
  onChange,
}: {
  value: string;
  zones: readonly string[];
  invalid: boolean;
  disabled: boolean;
  onChange: (timeZone: string) => void;
}) {
  const inputId = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={inputId}>Time zone</Label>
      <Combobox<string>
        disabled={disabled}
        filter={matchesTimeZone}
        items={zones}
        onValueChange={(zone) => {
          if (zone) {
            onChange(zone);
          }
        }}
        value={value}
      >
        <ComboboxInput
          aria-invalid={invalid || undefined}
          className="w-full"
          id={inputId}
          placeholder="Search time zones"
          triggerLabel="Show the time zones"
        />
        <ComboboxContent>
          <ComboboxEmpty>No time zone matches that.</ComboboxEmpty>
          <ComboboxList>
            {(zone: string) => (
              <ComboboxItem key={zone} value={zone}>
                {zone}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
