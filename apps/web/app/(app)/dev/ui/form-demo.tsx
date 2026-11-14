"use client";

import { Checkbox, FormField, Select, Textarea, TextInput } from "@/components/ui";

// FormField takes a render function as children, so it must be used from a client component.
export function FormDemo() {
  return (
    <>
      <FormField label="Full name" required hint="As on the ID document.">{(p) => <TextInput {...p} defaultValue="" />}</FormField>
      <FormField label="Email" error="Enter a valid email address.">{(p) => <TextInput {...p} type="email" defaultValue="not-an-email" />}</FormField>
      <FormField label="Role" required>
        {(p) => <Select {...p} placeholder="Choose a role" options={[{ value: "admin", label: "Admin" }, { value: "office", label: "Office staff" }]} />}
      </FormField>
      <FormField label="Notes">{(p) => <Textarea {...p} />}</FormField>
      <Checkbox label="Active" defaultChecked />
    </>
  );
}
