import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { CheckIcon, ZapIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, use } from "react";

import { cn } from "~/lib/utils";
import { UltrafastIcon } from "../Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerControlSize } from "./ComposerControl";
import { DockedPickerContext } from "./ProviderModelPicker";
import {
  buildTraitsTriggerDisplay,
  getTraitsSectionVisibility,
  REASONING_SELECT_DESCRIPTOR_IDS,
  type TraitsSelectionInput,
  ULTRATHINK_IN_BODY_NOTE,
  useTraitsSelection,
} from "./TraitsPicker";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;
type ColumnControl =
  | { kind: "select"; descriptor: SelectDescriptor }
  | { kind: "boolean"; descriptor: BooleanDescriptor };

/**
 * The column lists the model's reasoning control first, under the header that names it, then
 * its other options. Picking a level of that control finishes the job and closes the popup.
 */
function columnControls(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const controls: ReadonlyArray<ColumnControl> = [
    ...selects.map((descriptor) => ({ kind: "select" as const, descriptor })),
    ...toggles.map((descriptor) => ({ kind: "boolean" as const, descriptor })),
  ];
  const effort =
    controls.find((control) => REASONING_SELECT_DESCRIPTOR_IDS.has(control.descriptor.id)) ?? null;
  return { effort, others: controls.filter((control) => control !== effort) };
}

/** What the model trigger shows after the model name: the traits label and a speed bolt. */
export function describeComposerEffort(
  traits: TraitsSelectionInput | null,
  size: ComposerControlSize,
): { suffix: ReactNode; detail: string | null } {
  if (!traits) return { suffix: null, detail: null };
  const visibility = getTraitsSectionVisibility(traits);
  if (!visibility.hasAnyControls) return { suffix: null, detail: null };
  const display = buildTraitsTriggerDisplay({
    provider: traits.provider,
    descriptors: visibility.descriptors,
    primarySelectDescriptorId: visibility.primarySelectDescriptor?.id ?? null,
    ultrathinkPromptControlled: visibility.ultrathinkPromptControlled,
  });
  const SpeedIcon =
    display.speedIcon === "ultrafast" ? UltrafastIcon : display.speedIcon ? ZapIcon : null;
  return {
    detail: [
      display.label,
      display.speedIcon === "ultrafast" ? "Ultrafast" : display.speedIcon ? "Fast" : null,
    ]
      .filter(Boolean)
      .join(" · "),
    suffix: (
      <span
        data-chat-provider-model-picker-suffix="true"
        className={cn(
          "flex min-w-0 shrink items-center gap-1 text-muted-foreground group-hover/model-trigger:text-foreground group-data-popup-open/model-trigger:text-foreground",
          // A word space after the model name: the trigger's gap is wider than one.
          size === "sm" && "-ms-0.5",
        )}
      >
        {display.label ? <span className="min-w-0 truncate">{display.label}</span> : null}
        {SpeedIcon ? (
          <SpeedIcon aria-hidden="true" className="size-3 shrink-0 fill-current" />
        ) : null}
      </span>
    ),
  };
}

const COLUMN_ROW =
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm text-foreground outline-none hover:bg-foreground/[0.09] focus-visible:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-64";
const COLUMN_LABEL = "px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs";

function ColumnRow(props: {
  label: string;
  /** Shown on hover; the column is too narrow to print it under the label. */
  description?: string | undefined;
  selected: boolean;
  isDefault?: boolean | undefined;
  disabled?: boolean;
  /** A level of the reasoning control, where focus lands after a model pick. */
  level: boolean;
  onPick: () => void;
}) {
  const rowProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.selected,
    disabled: props.disabled,
    // The label, so a typed letter finds the row.
    "data-effort-row": props.label,
    "data-effort-level": props.level || undefined,
    // The reasoning control holds the column's one tab stop; Up and Down move between rows.
    tabIndex: props.selected && props.level ? 0 : -1,
    className: COLUMN_ROW,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.isDefault ? <span className="text-muted-foreground/70 text-xs">Default</span> : null}
      <CheckIcon aria-hidden="true" className={cn("size-3.5", !props.selected && "invisible")} />
    </>
  );
  if (!props.description) return <button {...rowProps}>{content}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...rowProps} />}>{content}</TooltipTrigger>
      <TooltipPopup side="right" className="max-w-56">
        {props.description}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Up and Down move between rows; a typed letter finds the next row whose label starts with it. */
function moveBetweenRows(event: KeyboardEvent<HTMLElement>) {
  const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
  if (
    !arrow &&
    (event.key.length !== 1 ||
      event.key.trim() === "" ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.nativeEvent.isComposing)
  )
    return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-effort-row]:not(:disabled)"),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  const next = arrow
    ? rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))]
    : [...rows.slice(index + 1), ...rows.slice(0, index + 1)].find((row) =>
        row.dataset.effortRow?.toLowerCase().startsWith(event.key.toLowerCase()),
      );
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

function NoEffortRow() {
  return (
    <div className="flex h-8 items-center px-2 text-muted-foreground text-sm">No effort levels</div>
  );
}

function EffortLevels(props: { traits: TraitsSelectionInput; onLevelPick: () => void }) {
  const traits = useTraitsSelection(props.traits);
  const { effort, others } = columnControls(traits.selectDescriptors, traits.booleanDescriptors);
  if (!effort && others.length === 0) return <NoEffortRow />;
  const renderControl = (control: ColumnControl) => {
    const isEffort = control === effort;
    if (control.kind === "boolean") {
      const { descriptor } = control;
      return (
        <div
          key={descriptor.id}
          role="radiogroup"
          aria-label={descriptor.label}
          className="flex flex-col gap-0.5"
        >
          {isEffort ? null : <div className={COLUMN_LABEL}>{descriptor.label}</div>}
          {([true, false] as const).map((value) => (
            <ColumnRow
              key={String(value)}
              label={value ? "On" : "Off"}
              selected={(descriptor.currentValue === true) === value}
              level={isEffort}
              onPick={() => {
                traits.changeBoolean(descriptor.id, value);
                if (isEffort) props.onLevelPick();
              }}
            />
          ))}
        </div>
      );
    }
    const { descriptor } = control;
    const locked =
      descriptor.id === traits.primarySelectDescriptor?.id && traits.ultrathinkInBodyText;
    const value = traits.selectValue(descriptor);
    return (
      <div
        key={descriptor.id}
        role="radiogroup"
        aria-label={descriptor.label}
        className="flex flex-col gap-0.5"
      >
        {isEffort ? null : <div className={COLUMN_LABEL}>{descriptor.label}</div>}
        {locked ? (
          <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
            {ULTRATHINK_IN_BODY_NOTE}
          </div>
        ) : null}
        {descriptor.options.map((option) => (
          <ColumnRow
            key={option.id}
            label={option.label}
            selected={option.id === value}
            description={option.description}
            isDefault={option.isDefault}
            disabled={locked}
            level={isEffort}
            onPick={() => {
              traits.changeSelect(descriptor, option.id);
              if (isEffort) props.onLevelPick();
            }}
          />
        ))}
      </div>
    );
  };
  return (
    <>
      {effort ? renderControl(effort) : null}
      {others.map(renderControl)}
    </>
  );
}

/** The model picker's effort column: the selected model's levels and its other options. */
export function ComposerEffortColumn(props: { traits: TraitsSelectionInput | null }) {
  const picker = use(DockedPickerContext);
  const visibility = props.traits ? getTraitsSectionVisibility(props.traits) : null;
  const effort = visibility
    ? columnControls(visibility.selectDescriptors, visibility.booleanDescriptors).effort
    : null;
  return (
    <>
      <div className="shrink-0 px-3 pt-2.5">
        <div className="flex h-8 items-center gap-2 border-b border-border/70 pb-1.5 text-sm">
          <span className="text-muted-foreground">{effort?.descriptor.label ?? "Effort"}</span>
          <span className="ms-auto min-w-0 truncate text-muted-foreground text-xs">
            {picker.modelLabel}
          </span>
        </div>
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pt-2 pb-1.5"
        onKeyDown={moveBetweenRows}
      >
        {props.traits ? (
          <EffortLevels traits={props.traits} onLevelPick={picker.close} />
        ) : (
          <NoEffortRow />
        )}
      </div>
    </>
  );
}
