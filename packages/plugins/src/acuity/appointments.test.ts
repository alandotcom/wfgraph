import { describe, expect, it } from "@effect/vitest";
import { AcuityError } from "@fountain-bio/acuity";
import { isEffectSchema } from "@rova/core/plugin";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { beforeEach, vi } from "vitest";
import {
  acuity,
  cancelAppointmentHandler,
  createAppointmentHandler,
  getAppointmentHandler,
  getAvailabilityDatesHandler,
  getAvailabilityTimesHandler,
  listAppointmentsHandler,
  listAppointmentTypesHandler,
  rescheduleAppointmentHandler,
} from "#src/acuity/index";

/**
 * The eight Acuity steps in one file, because what they have to say is the
 * same three things each: which config field it cannot read, which parameters
 * Acuity is asked for, and what a thrown SDK error reads as. The seam under all
 * of them is `@fountain-bio/acuity`, whose two resources are stubbed here.
 *
 * The text-to-number and text-to-boolean reading is shared, so each message is
 * asserted once, on whichever step first offers the field.
 */
const mocks = vi.hoisted(() => ({
  types: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  reschedule: vi.fn(),
  cancel: vi.fn(),
  dates: vi.fn(),
  times: vi.fn(),
}));

vi.mock("@fountain-bio/acuity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fountain-bio/acuity")>()),
  Acuity: class {
    appointments = {
      types: mocks.types,
      list: mocks.list,
      get: mocks.get,
      create: mocks.create,
      reschedule: mocks.reschedule,
      cancel: mocks.cancel,
    };
    availability = { dates: mocks.dates, times: mocks.times };
  },
}));

const ACUITY_CREDENTIALS = {
  ACUITY_USER_ID: "12345678",
  ACUITY_API_KEY: "acuity-key",
};

// What the SDK hands back, as much of it as the steps read.
/**
 * One appointment, shaped the way the API sends one rather than the way the SDK
 * types one.
 *
 * The SDK casts the response without validating it, so its types are not evidence.
 * Two things here are the corrections this fixture exists to hold: the timezone
 * Acuity sends is `timezone`, and `forms` is a list of forms each carrying its own
 * `values` list of answers. A `price` arriving as a number rather than the string
 * the SDK promises is the third: it is an undeclared shape the schema tolerates, and
 * it has to survive the encode.
 */
const APPOINTMENT = {
  id: 987,
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  date: "March 15, 2026",
  time: "3:00pm",
  endTime: "3:30pm",
  duration: "30",
  datetime: "2026-03-15T15:00:00-04:00",
  timezone: "America/New_York",
  type: "Consultation",
  appointmentTypeID: 12_345,
  calendar: "Main",
  calendarID: 67_890,
  price: 40,
  paid: "no",
  notes: null,
  scheduledBy: null,
  forms: [
    {
      id: 2_322_025,
      name: "Intake",
      values: [
        {
          id: 3_367_788_034,
          fieldID: 11_281_125,
          name: "Are you still using our App?",
          value: "no",
        },
      ],
    },
  ],
  canceled: false,
};

/** The credentials a run would have fetched. */
function credentialsRead(
  values: Record<string, string | undefined> = ACUITY_CREDENTIALS
) {
  return Effect.sync(() => values);
}

/** The one argument a handler takes, around the input the case is about. */
function bagFor<TInput>(
  input: TInput,
  credentials: Effect.Effect<Record<string, string | undefined>>
) {
  return {
    input,
    runMode: "live" as const,
    nodeId: "n1",
    nodeName: "Acuity",
    nodeType: "action",
    integrationId: "int_acuity",
    credentials,
    readCredentials: () => Effect.runPromise(credentials),
  };
}

/** A step that succeeds fails the flip, which is what makes the test say so. */
const failure = Effect.flip;

const withTransport = Effect.provide(FetchHttpClient.layer);

/** The credentials every case here runs with unless it says otherwise. */
function withCredentials() {
  return credentialsRead();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.types.mockResolvedValue([{ id: 1, name: "Consultation" }]);
  mocks.list.mockResolvedValue([APPOINTMENT]);
  mocks.get.mockResolvedValue(APPOINTMENT);
  mocks.create.mockResolvedValue(APPOINTMENT);
  mocks.reschedule.mockResolvedValue(APPOINTMENT);
  mocks.cancel.mockResolvedValue({ ...APPOINTMENT, canceled: true });
  mocks.dates.mockResolvedValue([{ date: "2026-03-15" }]);
  mocks.times.mockResolvedValue([{ time: "2026-03-15T15:00:00-04:00" }]);
});

describe("listAppointmentTypesHandler", () => {
  it.effect("counts what Acuity listed", () =>
    Effect.gen(function* () {
      const result = yield* listAppointmentTypesHandler(
        bagFor({}, withCredentials())
      );

      // The handler hands Acuity's own object back. What it omitted stays omitted:
      // every field of an appointment type tolerates an absent key, so there is
      // nothing to normalize and nothing that can fail the encode.
      expect(result).toEqual({
        appointmentTypes: [{ id: 1, name: "Consultation" }],
        count: 1,
      });
    }).pipe(withTransport)
  );

  // Every step builds its client the same way, so the message is asserted once.
  it.effect("names both credentials before reaching Acuity", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead({ ACUITY_USER_ID: "12345678" });

      const error = yield* failure(
        listAppointmentTypesHandler(bagFor({}, credentials))
      );

      expect(error.message).toBe(
        "ACUITY_USER_ID and ACUITY_API_KEY are required. Add them in Project Integrations."
      );
      expect(mocks.types).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  // An AcuityError carries the API's own words; anything else falls back to the
  // sentence the step passed in.
  it.effect(
    "falls back to the step's own words for an unclassifiable throw",
    () =>
      Effect.gen(function* () {
        mocks.types.mockRejectedValue({});

        const error = yield* failure(
          listAppointmentTypesHandler(bagFor({}, withCredentials()))
        );

        expect(error.message).toBe("Failed to list appointment types.");
      }).pipe(withTransport)
  );
});

describe("listAppointmentsHandler", () => {
  it.effect("sends Acuity's own parameter names", () =>
    Effect.gen(function* () {
      const result = yield* listAppointmentsHandler(
        bagFor(
          {
            appointmentTypeId: "12345",
            calendarId: "67890",
            minDate: "2026-03-01",
            maxDate: "2026-03-31",
            timezone: "America/New_York",
            email: "ada@example.com",
            phone: "+15551234567",
            canceled: "true",
            showAll: "false",
            limit: "50",
            page: 2,
          },
          withCredentials()
        )
      );

      expect(mocks.list).toHaveBeenCalledWith({
        appointmentTypeID: 12_345,
        calendarID: 67_890,
        minDate: "2026-03-01",
        maxDate: "2026-03-31",
        timezone: "America/New_York",
        email: "ada@example.com",
        phone: "+15551234567",
        canceled: true,
        showall: false,
        limit: 50,
        page: 2,
      });
      expect(result).toEqual({ appointments: [APPOINTMENT], count: 1 });
    }).pipe(withTransport)
  );

  // A blank filter is no filter, which is what the select's empty option means.
  it.effect("leaves out the filters that were not filled in", () =>
    Effect.gen(function* () {
      yield* listAppointmentsHandler(
        bagFor({ canceled: "", showAll: "", calendarId: "" }, withCredentials())
      );

      expect(mocks.list).toHaveBeenCalledWith({
        appointmentTypeID: undefined,
        calendarID: undefined,
        minDate: undefined,
        maxDate: undefined,
        timezone: undefined,
        email: undefined,
        phone: undefined,
        canceled: undefined,
        showall: undefined,
        limit: undefined,
        page: undefined,
      });
    }).pipe(withTransport)
  );

  it.effect("names the field a non-integer was typed into", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        listAppointmentsHandler(
          bagFor({ calendarId: "not-a-number" }, withCredentials())
        )
      );

      expect(error.message).toBe("Calendar ID must be a positive integer.");
      expect(mocks.list).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("names the field a non-boolean was typed into", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        listAppointmentsHandler(
          bagFor({ canceled: "maybe" }, withCredentials())
        )
      );

      expect(error.message).toBe(
        "Only Canceled must be true, false, or empty."
      );
    }).pipe(withTransport)
  );
});

describe("getAppointmentHandler", () => {
  it.effect("offers the id and datetime beside the appointment", () =>
    Effect.gen(function* () {
      const result = yield* getAppointmentHandler(
        bagFor(
          { appointmentId: "987", pastFormAnswers: "true" },
          withCredentials()
        )
      );

      expect(mocks.get).toHaveBeenCalledWith(987, { pastFormAnswers: true });
      expect(result).toEqual({
        appointment: APPOINTMENT,
        id: 987,
        datetime: "2026-03-15T15:00:00-04:00",
      });
    }).pipe(withTransport)
  );

  it.effect("asks for the appointment id it cannot do without", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        getAppointmentHandler(
          bagFor({ appointmentId: "  " }, withCredentials())
        )
      );

      expect(error.message).toBe("Appointment ID is required.");
      expect(mocks.get).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );
});

describe("getAvailabilityDatesHandler", () => {
  it.effect("sends the month and type Acuity asks for", () =>
    Effect.gen(function* () {
      const result = yield* getAvailabilityDatesHandler(
        bagFor(
          {
            month: "2026-03",
            appointmentTypeId: "12345",
            calendarId: "67890",
            timezone: "America/New_York",
          },
          withCredentials()
        )
      );

      expect(mocks.dates).toHaveBeenCalledWith({
        month: "2026-03",
        appointmentTypeID: 12_345,
        calendarID: 67_890,
        timezone: "America/New_York",
      });
      expect(result).toEqual({ dates: [{ date: "2026-03-15" }], count: 1 });
    }).pipe(withTransport)
  );

  it.effect("says what a month has to look like", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        getAvailabilityDatesHandler(
          bagFor({ month: "  ", appointmentTypeId: "12345" }, withCredentials())
        )
      );

      expect(error.message).toBe(
        "Month is required and must use YYYY-MM format."
      );
      expect(mocks.dates).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );
});

describe("getAvailabilityTimesHandler", () => {
  // Ignoring the appointment being moved is what lets its own slot show up
  // again, so the list has to reach Acuity as numbers.
  it.effect("reads the ignore list as the numbers Acuity takes", () =>
    Effect.gen(function* () {
      const result = yield* getAvailabilityTimesHandler(
        bagFor(
          {
            date: "2026-03-15",
            appointmentTypeId: "12345",
            ignoreAppointmentIds: " 111 , 222 ",
          },
          withCredentials()
        )
      );

      expect(mocks.times).toHaveBeenCalledWith({
        date: "2026-03-15",
        appointmentTypeID: 12_345,
        calendarID: undefined,
        timezone: undefined,
        ignoreAppointmentIDs: [111, 222],
      });
      expect(result.count).toBe(1);
    }).pipe(withTransport)
  );

  it.effect("names the ignore list when it holds something else", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        getAvailabilityTimesHandler(
          bagFor(
            {
              date: "2026-03-15",
              appointmentTypeId: "12345",
              ignoreAppointmentIds: "111,abc",
            },
            withCredentials()
          )
        )
      );

      expect(error.message).toBe(
        "Ignore Appointment IDs must contain only positive integers (comma separated)."
      );
    }).pipe(withTransport)
  );

  it.effect("says what a date has to look like", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        getAvailabilityTimesHandler(
          bagFor({ date: "", appointmentTypeId: "12345" }, withCredentials())
        )
      );

      expect(error.message).toBe(
        "Date is required and must use YYYY-MM-DD format."
      );
    }).pipe(withTransport)
  );
});

describe("createAppointmentHandler", () => {
  it.effect("sends the booking and the mutation flags separately", () =>
    Effect.gen(function* () {
      const result = yield* createAppointmentHandler(
        bagFor(
          {
            datetime: "2026-03-15T15:00:00-04:00",
            appointmentTypeId: "12345",
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.com",
            phone: "+15551234567",
            calendarId: "67890",
            notes: "Bring records",
            smsOptIn: "true",
            customFieldsJson: '[{"fieldID":1234,"value":"Some answer"}]',
            admin: "true",
            noEmail: "false",
          },
          withCredentials()
        )
      );

      expect(mocks.create).toHaveBeenCalledWith(
        {
          datetime: "2026-03-15T15:00:00-04:00",
          appointmentTypeID: 12_345,
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
          phone: "+15551234567",
          calendarID: 67_890,
          notes: "Bring records",
          smsOptIn: true,
          fields: [{ fieldID: 1234, value: "Some answer" }],
        },
        { admin: true, noEmail: false }
      );
      expect(result).toEqual({
        appointment: APPOINTMENT,
        id: 987,
        datetime: "2026-03-15T15:00:00-04:00",
      });
    }).pipe(withTransport)
  );

  it.effect("says what the custom fields JSON has to look like", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        createAppointmentHandler(
          bagFor(
            {
              datetime: "2026-03-15T15:00:00-04:00",
              appointmentTypeId: "12345",
              firstName: "Ada",
              lastName: "Lovelace",
              email: "ada@example.com",
              phone: "+15551234567",
              customFieldsJson: "not json",
            },
            withCredentials()
          )
        )
      );

      expect(error.message).toBe(
        'Custom Fields JSON must be valid JSON in the format [{"fieldID":1234,"value":"text"}].'
      );
      expect(mocks.create).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("asks for the client's name", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        createAppointmentHandler(
          bagFor(
            {
              datetime: "2026-03-15T15:00:00-04:00",
              appointmentTypeId: "12345",
              firstName: "Ada",
              lastName: "  ",
              email: "ada@example.com",
              phone: "+15551234567",
            },
            withCredentials()
          )
        )
      );

      expect(error.message).toBe("First Name and Last Name are required.");
    }).pipe(withTransport)
  );

  it.effect("asks for a way to reach the client", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        createAppointmentHandler(
          bagFor(
            {
              datetime: "2026-03-15T15:00:00-04:00",
              appointmentTypeId: "12345",
              firstName: "Ada",
              lastName: "Lovelace",
              email: "ada@example.com",
              phone: "",
            },
            withCredentials()
          )
        )
      );

      expect(error.message).toBe("Email and Phone are required.");
    }).pipe(withTransport)
  );

  it.effect("says what a datetime has to look like", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        createAppointmentHandler(
          bagFor(
            {
              datetime: " ",
              appointmentTypeId: "12345",
              firstName: "Ada",
              lastName: "Lovelace",
              email: "ada@example.com",
              phone: "+15551234567",
            },
            withCredentials()
          )
        )
      );

      expect(error.message).toBe("Datetime is required (ISO 8601 format).");
    }).pipe(withTransport)
  );
});

describe("rescheduleAppointmentHandler", () => {
  it.effect("sends the new datetime and the mutation flags", () =>
    Effect.gen(function* () {
      const result = yield* rescheduleAppointmentHandler(
        bagFor(
          {
            appointmentId: "987",
            datetime: "2026-03-16T10:00:00-04:00",
            calendarId: "67890",
            admin: "true",
            noEmail: "true",
          },
          withCredentials()
        )
      );

      expect(mocks.reschedule).toHaveBeenCalledWith(
        987,
        { datetime: "2026-03-16T10:00:00-04:00", calendarID: 67_890 },
        { admin: true, noEmail: true }
      );
      expect(result.id).toBe(987);
    }).pipe(withTransport)
  );

  it.effect("says what a new datetime has to look like", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        rescheduleAppointmentHandler(
          bagFor({ appointmentId: "987", datetime: "" }, withCredentials())
        )
      );

      expect(error.message).toBe("New Datetime is required (ISO 8601 format).");
      expect(mocks.reschedule).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );
});

describe("cancelAppointmentHandler", () => {
  it.effect("sends the note and the flags Acuity takes", () =>
    Effect.gen(function* () {
      const result = yield* cancelAppointmentHandler(
        bagFor(
          {
            appointmentId: "987",
            cancelNote: "Client rescheduled by phone",
            noShow: "false",
            admin: "true",
            noEmail: "true",
          },
          withCredentials()
        )
      );

      expect(mocks.cancel).toHaveBeenCalledWith(
        987,
        { cancelNote: "Client rescheduled by phone", noShow: false },
        { admin: true, noEmail: true }
      );
      expect(result).toEqual({
        appointment: { ...APPOINTMENT, canceled: true },
        id: 987,
        canceled: true,
      });
    }).pipe(withTransport)
  );

  it.effect("reports what a plain Error said", () =>
    Effect.gen(function* () {
      mocks.cancel.mockRejectedValue(new Error("Appointment already canceled"));

      const error = yield* failure(
        cancelAppointmentHandler(
          bagFor({ appointmentId: "987" }, withCredentials())
        )
      );

      expect(error.message).toBe("Appointment already canceled");
    }).pipe(withTransport)
  );

  it.effect("reports what an AcuityError said", () =>
    Effect.gen(function* () {
      mocks.cancel.mockRejectedValue(
        new AcuityError({
          status: 400,
          message: "Appointment already canceled",
        })
      );

      const error = yield* failure(
        cancelAppointmentHandler(
          bagFor({ appointmentId: "987" }, withCredentials())
        )
      );

      expect(error.message).toBe("Appointment already canceled");
    }).pipe(withTransport)
  );
});

/**
 * What each appointment-returning handler answers, put through the encode that
 * carries it to the run.
 *
 * This is the case the batch owed, and the pair is the point: the handler tests
 * above stop at the handler, and the field-derivation tests never encode a payload,
 * so a schema that disagreed with the wire failed no test while failing every run.
 * All five did, on any appointment carrying an intake form.
 *
 * The bound step is one layer further out and needs a database for its credential
 * fetch and its run log, so what runs here is the handler with the stubbed client
 * and the action's own output codec -- which is the layer the mistake was in.
 */
describe("an appointment through the encode", () => {
  // A step's schemas are typed as any Standard Schema, so reaching the codec
  // asks whose they are. These are Effect's, and a definition that stopped being
  // one would silently skip the encode this file exists to run.
  function encodeOutputOf(slug: keyof typeof acuity.actions) {
    const schema = acuity.actions[slug].output;
    if (!isEffectSchema<unknown, never>(schema)) {
      throw new Error(
        `Action "acuity/${slug}" no longer holds an Effect schema`
      );
    }

    return Schema.encodeUnknownPromise(Schema.toCodecJson(schema));
  }

  it.effect(
    "keeps the whole appointment on the way out of get-appointment",
    () =>
      Effect.gen(function* () {
        const result = yield* getAppointmentHandler(
          bagFor({ appointmentId: "987" }, withCredentials())
        );

        const encoded = (yield* Effect.promise(() =>
          encodeOutputOf("get-appointment")(result)
        )) as { appointment: Record<string, unknown> };

        // The intake answer survives two levels down, the number-valued price
        // survives a field the SDK types as a string, and the timezone is the name
        // Acuity actually sends.
        expect(encoded.appointment.forms).toEqual(APPOINTMENT.forms);
        expect(encoded.appointment.price).toBe(40);
        expect(encoded.appointment.timezone).toBe("America/New_York");
      }).pipe(withTransport)
  );

  it.effect("keeps every appointment on the way out of list-appointments", () =>
    Effect.gen(function* () {
      const result = yield* listAppointmentsHandler(
        bagFor({}, withCredentials())
      );

      const encoded = (yield* Effect.promise(() =>
        encodeOutputOf("list-appointments")(result)
      )) as { appointments: Array<Record<string, unknown>>; count: number };

      expect(encoded.count).toBe(1);
      expect(encoded.appointments[0].forms).toEqual(APPOINTMENT.forms);
    }).pipe(withTransport)
  );

  it.effect(
    "keeps the appointment on the way out of the three that write one",
    () =>
      Effect.gen(function* () {
        const created = yield* createAppointmentHandler(
          bagFor(
            {
              datetime: "2026-03-15T15:00:00-04:00",
              appointmentTypeId: "12345",
              firstName: "Ada",
              lastName: "Lovelace",
              email: "ada@example.com",
              phone: "+15555550123",
            },
            withCredentials()
          )
        );
        const rescheduled = yield* rescheduleAppointmentHandler(
          bagFor(
            { appointmentId: "987", datetime: "2026-03-16T15:00:00-04:00" },
            withCredentials()
          )
        );
        const canceled = yield* cancelAppointmentHandler(
          bagFor({ appointmentId: "987" }, withCredentials())
        );

        for (const [slug, result] of [
          ["create-appointment", created],
          ["reschedule-appointment", rescheduled],
          ["cancel-appointment", canceled],
        ] as const) {
          const encoded = (yield* Effect.promise(() =>
            encodeOutputOf(slug)(result)
          )) as { appointment: Record<string, unknown> };

          expect(encoded.appointment.forms).toEqual(APPOINTMENT.forms);
        }
      }).pipe(withTransport)
  );

  // An appointment type is the other wire shape these actions answer with, and
  // every one of its fields tolerates an absent key: what Acuity omitted stays
  // omitted rather than failing the encode.
  it.effect("keeps a sparse appointment type on the way out", () =>
    Effect.gen(function* () {
      const result = yield* listAppointmentTypesHandler(
        bagFor({}, withCredentials())
      );

      const encoded = (yield* Effect.promise(() =>
        encodeOutputOf("list-appointment-types")(result)
      )) as { appointmentTypes: Array<Record<string, unknown>> };

      expect(encoded.appointmentTypes).toEqual([
        { id: 1, name: "Consultation" },
      ]);
    }).pipe(withTransport)
  );
});
