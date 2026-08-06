import { InfoIcon, SettingsIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type JSX } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { ConfigFieldKind, useAppConfig, type ConfigField } from "../hooks/useAppConfig";

/** Props of {@link FieldInfo}. */
interface FieldInfoProps {
  readonly field: ConfigField;
}

/** The info icon beside a field, showing what the value means on hover. */
const FieldInfo = ({ field }: FieldInfoProps): JSX.Element => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground"
        aria-label={`About ${field.label}`}
      >
        <InfoIcon aria-hidden="true" />
      </Button>
    </TooltipTrigger>
    <TooltipContent side="left" className="max-w-64">
      {field.info}
    </TooltipContent>
  </Tooltip>
);

/** Props of {@link FieldWalletWarning}. */
interface FieldWalletWarningProps {
  readonly field: ConfigField;
  /** The wallet's own value, already known to differ from the app's. */
  readonly walletValue: string;
}

/** The warning beside a field whose value the connected wallet disagrees with. */
const FieldWalletWarning = ({ field, walletValue }: FieldWalletWarningProps): JSX.Element => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-destructive hover:text-destructive"
        aria-label={`${field.label} differs from the connected wallet`}
      >
        <TriangleAlertIcon aria-hidden="true" />
      </Button>
    </TooltipTrigger>
    <TooltipContent side="left" className="max-w-64">
      The connected wallet uses {walletValue}
    </TooltipContent>
  </Tooltip>
);

/** Props of {@link ConfigFieldRow}. */
interface ConfigFieldRowProps {
  readonly field: ConfigField;
}

/**
 * One field of the panel: a label, the control its kind calls for, and the
 * info (and, where the wallet disagrees, warning) icons beside it.
 *
 * A text field edits a DRAFT: the value commits on blur or Enter, so a
 * half-typed URL is never applied keystroke by keystroke. A rejected commit
 * (reported on a toast by the field itself) keeps the draft in place for
 * correcting, and a committed one drops it and shows the stored value again.
 */
const ConfigFieldRow = ({ field }: ConfigFieldRowProps): JSX.Element => {
  const [draft, setDraft] = useState<string | null>(null);
  const inputId = `config-${field.key}`;

  const commitDraft = (): void => {
    if (draft === null || draft === field.value) {
      setDraft(null);
      return;
    }
    if (field.apply(draft)) {
      setDraft(null);
    }
  };

  const warning = field.walletValue;

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={inputId} className="text-xs text-muted-foreground">
        {field.label}
      </Label>
      <div className="flex items-center gap-1">
        {field.kind === ConfigFieldKind.Select ? (
          <Select
            value={field.value}
            onValueChange={(value) => {
              field.apply(value);
            }}
          >
            <SelectTrigger id={inputId} aria-label={field.label} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id={inputId}
            value={draft ?? field.value}
            placeholder={field.placeholder}
            aria-invalid={warning === undefined ? undefined : true}
            className={
              warning === undefined ? undefined : "border-destructive focus-visible:ring-destructive"
            }
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitDraft();
              }
            }}
          />
        )}
        {warning === undefined ? (
          <FieldInfo field={field} />
        ) : (
          <FieldWalletWarning field={field} walletValue={warning} />
        )}
      </div>
    </div>
  );
};

/**
 * The configuration control in the header: a gear that opens every
 * configurable value of the app, grouped by surface (vault, then one section
 * per chain), each field with an info tooltip and, where the connected
 * wallet reports a differing endpoint, a warning.
 *
 * Presentational: which values exist, what they mean and how they apply all
 * live in {@link useAppConfig}. It sits in the shell for the same reason the
 * wallet controls do: configuration outlives navigation.
 *
 * @returns The trigger and its panel.
 */
export const ConfigMenu = (): JSX.Element => {
  const sections = useAppConfig();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Configuration"
          title="Configuration"
          className="text-muted-foreground"
        >
          <SettingsIcon aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[70vh] w-96 overflow-y-auto">
        <TooltipProvider>
          <div className="flex flex-col gap-4">
            {sections.map((section) => (
              <section key={section.title} aria-label={`${section.title} configuration`}>
                <h3 className="mb-2 text-sm font-semibold">{section.title}</h3>
                <div className="flex flex-col gap-2.5">
                  {section.fields.map((field) => (
                    <ConfigFieldRow key={field.key} field={field} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </TooltipProvider>
      </PopoverContent>
    </Popover>
  );
};
