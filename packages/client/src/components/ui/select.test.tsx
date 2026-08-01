import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#src/components/ui/select";

function renderSelect(value: string | null, items: string[] = ["a"]) {
  return render(
    <Select value={value}>
      <SelectTrigger>
        <SelectValue placeholder="Select value" />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item} value={item}>
            {item.toUpperCase()}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

describe("SelectValue", () => {
  it("shows the placeholder when nothing is chosen", () => {
    renderSelect(null);

    expect(screen.getByText("Select value")).toBeTruthy();
  });

  it("shows the placeholder for an empty value, which chooses nothing", () => {
    renderSelect("");

    expect(screen.getByText("Select value")).toBeTruthy();
  });

  it("shows the chosen item's label", () => {
    renderSelect("a");

    expect(screen.getByText("A")).toBeTruthy();
  });

  it("shows a value the items no longer offer as itself", () => {
    renderSelect("gone");

    expect(screen.getByText("gone")).toBeTruthy();
  });
});
