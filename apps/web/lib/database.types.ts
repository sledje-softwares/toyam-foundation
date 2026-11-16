
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "app_settings": {
                  Row: {
                    "description": string | null,"key": string,"updated_at": string,"value": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "description"?: string | null,"key": string,"updated_at"?: string,"value": NonNullable<Json>
                  }
                  Update: {
                    "description"?: string | null,"key"?: string,"updated_at"?: string,"value"?: NonNullable<Json>
                  }
                  Relationships: [
                    
                  ]
                },"assignment_rule_members": {
                  Row: {
                    "profile_id": string,"rule_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "profile_id": string,"rule_id": string
                  }
                  Update: {
                    "profile_id"?: string,"rule_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "assignment_rule_members_profile_id_fkey"
      columns: ["profile_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "assignment_rule_members_rule_id_fkey"
      columns: ["rule_id"]
isOneToOne: false
      referencedRelation: "assignment_rules"
      referencedColumns: ["id"]
    }
                  ]
                },"assignment_rules": {
                  Row: {
                    "claim_type": Database["public"]['Enums']["claim_type"] | null,"created_at": string,"id": string,"insurer_id": string | null,"is_active": boolean,"name": string,"priority": number,"strategy": Database["public"]['Enums']["assignment_strategy"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "claim_type"?: Database["public"]['Enums']["claim_type"] | null,"created_at"?: string,"id"?: string,"insurer_id"?: string | null,"is_active"?: boolean,"name": string,"priority"?: number,"strategy"?: Database["public"]['Enums']["assignment_strategy"],"updated_at"?: string
                  }
                  Update: {
                    "claim_type"?: Database["public"]['Enums']["claim_type"] | null,"created_at"?: string,"id"?: string,"insurer_id"?: string | null,"is_active"?: boolean,"name"?: string,"priority"?: number,"strategy"?: Database["public"]['Enums']["assignment_strategy"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "assignment_rules_insurer_id_fkey"
      columns: ["insurer_id"]
isOneToOne: false
      referencedRelation: "insurers"
      referencedColumns: ["id"]
    }
                  ]
                },"audit_log": {
                  Row: {
                    "action": string,"actor_id": string | null,"at": string,"id": number,"new_data": Json | null,"old_data": Json | null,"record_id": string | null,"table_name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"at"?: string,"id"?: never,"new_data"?: Json | null,"old_data"?: Json | null,"record_id"?: string | null,"table_name": string
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"at"?: string,"id"?: never,"new_data"?: Json | null,"old_data"?: Json | null,"record_id"?: string | null,"table_name"?: string
                  }
                  Relationships: [
                    
                  ]
                },"case_assignments": {
                  Row: {
                    "assigned_at": string,"assigned_by": string | null,"assignee_id": string,"case_id": string,"id": number,"method": string,"reason": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "assigned_at"?: string,"assigned_by"?: string | null,"assignee_id": string,"case_id": string,"id"?: never,"method": string,"reason"?: string | null
                  }
                  Update: {
                    "assigned_at"?: string,"assigned_by"?: string | null,"assignee_id"?: string,"case_id"?: string,"id"?: never,"method"?: string,"reason"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "case_assignments_assigned_by_fkey"
      columns: ["assigned_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_assignments_assignee_id_fkey"
      columns: ["assignee_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_assignments_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_assignments_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_assignments_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    }
                  ]
                },"case_entities": {
                  Row: {
                    "case_id": string,"entity_id": string,"relation": string
                  }
                  ComputedFields: never
                  Insert: {
                    "case_id": string,"entity_id": string,"relation"?: string
                  }
                  Update: {
                    "case_id"?: string,"entity_id"?: string,"relation"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "case_entities_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_entities_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_entities_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    },{
      foreignKeyName: "case_entities_entity_id_fkey"
      columns: ["entity_id"]
isOneToOne: false
      referencedRelation: "entities"
      referencedColumns: ["id"]
    }
                  ]
                },"case_field_values": {
                  Row: {
                    "case_id": string,"confidence": number | null,"field_id": string,"id": string,"source": Database["public"]['Enums']["field_value_source"],"source_evidence_id": string | null,"source_ref": Json | null,"updated_at": string,"updated_by": string | null,"value": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "case_id": string,"confidence"?: number | null,"field_id": string,"id"?: string,"source"?: Database["public"]['Enums']["field_value_source"],"source_evidence_id"?: string | null,"source_ref"?: Json | null,"updated_at"?: string,"updated_by"?: string | null,"value"?: string | null
                  }
                  Update: {
                    "case_id"?: string,"confidence"?: number | null,"field_id"?: string,"id"?: string,"source"?: Database["public"]['Enums']["field_value_source"],"source_evidence_id"?: string | null,"source_ref"?: Json | null,"updated_at"?: string,"updated_by"?: string | null,"value"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "case_field_values_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_field_values_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_field_values_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    },{
      foreignKeyName: "case_field_values_field_id_fkey"
      columns: ["field_id"]
isOneToOne: false
      referencedRelation: "case_template_fields"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_field_values_source_evidence_id_fkey"
      columns: ["source_evidence_id"]
isOneToOne: false
      referencedRelation: "evidence"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_field_values_source_evidence_id_fkey"
      columns: ["source_evidence_id"]
isOneToOne: false
      referencedRelation: "v_evidence_processing"
      referencedColumns: ["evidence_id"]
    },{
      foreignKeyName: "case_field_values_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"case_messages": {
                  Row: {
                    "body": string | null,"case_id": string,"client_message_id": string | null,"created_at": string,"id": string,"kind": Database["public"]['Enums']["message_kind"],"reply_to_id": string | null,"sender_id": string | null,"task_id": string | null,"visibility": string,"withdrawn_at": string | null,"withdrawn_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "body"?: string | null,"case_id": string,"client_message_id"?: string | null,"created_at"?: string,"id"?: string,"kind": Database["public"]['Enums']["message_kind"],"reply_to_id"?: string | null,"sender_id"?: string | null,"task_id"?: string | null,"visibility"?: string,"withdrawn_at"?: string | null,"withdrawn_by"?: string | null
                  }
                  Update: {
                    "body"?: string | null,"case_id"?: string,"client_message_id"?: string | null,"created_at"?: string,"id"?: string,"kind"?: Database["public"]['Enums']["message_kind"],"reply_to_id"?: string | null,"sender_id"?: string | null,"task_id"?: string | null,"visibility"?: string,"withdrawn_at"?: string | null,"withdrawn_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "case_messages_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_messages_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_messages_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    },{
      foreignKeyName: "case_messages_reply_to_id_fkey"
      columns: ["reply_to_id"]
isOneToOne: false
      referencedRelation: "case_messages"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_messages_sender_id_fkey"
      columns: ["sender_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_messages_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_messages_withdrawn_by_fkey"
      columns: ["withdrawn_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"case_status_history": {
                  Row: {
                    "case_id": string,"changed_at": string,"changed_by": string | null,"from_status": Database["public"]['Enums']["case_status"] | null,"id": number,"note": string | null,"to_status": Database["public"]['Enums']["case_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "case_id": string,"changed_at"?: string,"changed_by"?: string | null,"from_status"?: Database["public"]['Enums']["case_status"] | null,"id"?: never,"note"?: string | null,"to_status": Database["public"]['Enums']["case_status"]
                  }
                  Update: {
                    "case_id"?: string,"changed_at"?: string,"changed_by"?: string | null,"from_status"?: Database["public"]['Enums']["case_status"] | null,"id"?: never,"note"?: string | null,"to_status"?: Database["public"]['Enums']["case_status"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "case_status_history_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_status_history_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_status_history_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    },{
      foreignKeyName: "case_status_history_changed_by_fkey"
      columns: ["changed_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"case_template_checklists": {
                  Row: {
                    "checklist_template_id": string,"is_default": boolean,"template_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "checklist_template_id": string,"is_default"?: boolean,"template_id": string
                  }
                  Update: {
                    "checklist_template_id"?: string,"is_default"?: boolean,"template_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "case_template_checklists_checklist_template_id_fkey"
      columns: ["checklist_template_id"]
isOneToOne: false
      referencedRelation: "checklist_templates"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_template_checklists_template_id_fkey"
      columns: ["template_id"]
isOneToOne: false
      referencedRelation: "case_templates"
      referencedColumns: ["id"]
    }
                  ]
                },"case_template_fields": {
                  Row: {
                    "extract": NonNullable<Json>,"field_type": Database["public"]['Enums']["template_field_type"],"help_text": string | null,"id": string,"is_required": boolean,"key": string,"label": string,"options": NonNullable<Json>,"position": number,"section_id": string,"source": Database["public"]['Enums']["template_field_source"],"template_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "extract"?: NonNullable<Json>,"field_type"?: Database["public"]['Enums']["template_field_type"],"help_text"?: string | null,"id"?: string,"is_required"?: boolean,"key": string,"label": string,"options"?: NonNullable<Json>,"position": number,"section_id": string,"source"?: Database["public"]['Enums']["template_field_source"],"template_id": string
                  }
                  Update: {
                    "extract"?: NonNullable<Json>,"field_type"?: Database["public"]['Enums']["template_field_type"],"help_text"?: string | null,"id"?: string,"is_required"?: boolean,"key"?: string,"label"?: string,"options"?: NonNullable<Json>,"position"?: number,"section_id"?: string,"source"?: Database["public"]['Enums']["template_field_source"],"template_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "case_template_fields_section_id_template_id_fkey"
      columns: ["section_id","template_id"]
isOneToOne: false
      referencedRelation: "case_template_sections"
      referencedColumns: ["id","template_id"]
    }
                  ]
                },"case_template_section_categories": {
                  Row: {
                    "category_id": string,"position": number,"section_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "category_id": string,"position"?: number,"section_id": string
                  }
                  Update: {
                    "category_id"?: string,"position"?: number,"section_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "case_template_section_categories_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "evidence_categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_template_section_categories_section_id_fkey"
      columns: ["section_id"]
isOneToOne: false
      referencedRelation: "case_template_sections"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_template_section_categories_section_id_fkey"
      columns: ["section_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["section_id"]
    }
                  ]
                },"case_template_sections": {
                  Row: {
                    "guidance": string | null,"id": string,"key": string,"position": number,"template_id": string,"title": string
                  }
                  ComputedFields: never
                  Insert: {
                    "guidance"?: string | null,"id"?: string,"key": string,"position": number,"template_id": string,"title": string
                  }
                  Update: {
                    "guidance"?: string | null,"id"?: string,"key"?: string,"position"?: number,"template_id"?: string,"title"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "case_template_sections_template_id_fkey"
      columns: ["template_id"]
isOneToOne: false
      referencedRelation: "case_templates"
      referencedColumns: ["id"]
    }
                  ]
                },"case_templates": {
                  Row: {
                    "claim_type": Database["public"]['Enums']["claim_type"],"config_sha256": string | null,"created_at": string,"created_by": string | null,"default_output_format": string,"docx_template_path": string | null,"id": string,"insurer_id": string,"intake_rules": NonNullable<Json>,"is_active": boolean,"name": string,"output_formats": (string)[],"report_email": NonNullable<Json>,"report_layout": Json | null,"requires_approval": boolean,"source_file": string | null,"updated_at": string,"variant": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "claim_type": Database["public"]['Enums']["claim_type"],"config_sha256"?: string | null,"created_at"?: string,"created_by"?: string | null,"default_output_format"?: string,"docx_template_path"?: string | null,"id"?: string,"insurer_id": string,"intake_rules"?: NonNullable<Json>,"is_active"?: boolean,"name": string,"output_formats"?: (string)[],"report_email"?: NonNullable<Json>,"report_layout"?: Json | null,"requires_approval"?: boolean,"source_file"?: string | null,"updated_at"?: string,"variant"?: string,"version"?: number
                  }
                  Update: {
                    "claim_type"?: Database["public"]['Enums']["claim_type"],"config_sha256"?: string | null,"created_at"?: string,"created_by"?: string | null,"default_output_format"?: string,"docx_template_path"?: string | null,"id"?: string,"insurer_id"?: string,"intake_rules"?: NonNullable<Json>,"is_active"?: boolean,"name"?: string,"output_formats"?: (string)[],"report_email"?: NonNullable<Json>,"report_layout"?: Json | null,"requires_approval"?: boolean,"source_file"?: string | null,"updated_at"?: string,"variant"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "case_templates_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_templates_insurer_id_fkey"
      columns: ["insurer_id"]
isOneToOne: false
      referencedRelation: "insurers"
      referencedColumns: ["id"]
    }
                  ]
                },"case_thread_reads": {
                  Row: {
                    "case_id": string,"last_read_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "case_id": string,"last_read_at"?: string,"user_id": string
                  }
                  Update: {
                    "case_id"?: string,"last_read_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "case_thread_reads_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_thread_reads_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "case_thread_reads_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    },{
      foreignKeyName: "case_thread_reads_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"cases": {
                  Row: {
                    "assignment_method": string | null,"case_ref": string,"claim_amount": number | null,"claim_type": Database["public"]['Enums']["claim_type"],"closed_at": string | null,"created_at": string,"created_by": string | null,"due_at": string | null,"id": string,"incident_date": string | null,"insurer_claim_no": string,"insurer_id": string,"office_assigned_at": string | null,"office_owner_id": string | null,"orchestrator_id": string | null,"policy_no": string | null,"received_at": string,"status": Database["public"]['Enums']["case_status"],"suspicion_summary": string | null,"template_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assignment_method"?: string | null,"case_ref": string,"claim_amount"?: number | null,"claim_type": Database["public"]['Enums']["claim_type"],"closed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"due_at"?: string | null,"id"?: string,"incident_date"?: string | null,"insurer_claim_no": string,"insurer_id": string,"office_assigned_at"?: string | null,"office_owner_id"?: string | null,"orchestrator_id"?: string | null,"policy_no"?: string | null,"received_at"?: string,"status"?: Database["public"]['Enums']["case_status"],"suspicion_summary"?: string | null,"template_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "assignment_method"?: string | null,"case_ref"?: string,"claim_amount"?: number | null,"claim_type"?: Database["public"]['Enums']["claim_type"],"closed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"due_at"?: string | null,"id"?: string,"incident_date"?: string | null,"insurer_claim_no"?: string,"insurer_id"?: string,"office_assigned_at"?: string | null,"office_owner_id"?: string | null,"orchestrator_id"?: string | null,"policy_no"?: string | null,"received_at"?: string,"status"?: Database["public"]['Enums']["case_status"],"suspicion_summary"?: string | null,"template_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "cases_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cases_insurer_id_fkey"
      columns: ["insurer_id"]
isOneToOne: false
      referencedRelation: "insurers"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cases_office_owner_id_fkey"
      columns: ["office_owner_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cases_orchestrator_id_fkey"
      columns: ["orchestrator_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cases_template_id_fkey"
      columns: ["template_id"]
isOneToOne: false
      referencedRelation: "case_templates"
      referencedColumns: ["id"]
    }
                  ]
                },"checklist_template_items": {
                  Row: {
                    "camera_only": boolean,"category_id": string | null,"description": string,"id": string,"is_mandatory": boolean,"position": number,"required_evidence_type": Database["public"]['Enums']["evidence_type"],"template_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "camera_only"?: boolean,"category_id"?: string | null,"description": string,"id"?: string,"is_mandatory"?: boolean,"position": number,"required_evidence_type"?: Database["public"]['Enums']["evidence_type"],"template_id": string
                  }
                  Update: {
                    "camera_only"?: boolean,"category_id"?: string | null,"description"?: string,"id"?: string,"is_mandatory"?: boolean,"position"?: number,"required_evidence_type"?: Database["public"]['Enums']["evidence_type"],"template_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "checklist_template_items_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "evidence_categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "checklist_template_items_template_id_fkey"
      columns: ["template_id"]
isOneToOne: false
      referencedRelation: "checklist_templates"
      referencedColumns: ["id"]
    }
                  ]
                },"checklist_templates": {
                  Row: {
                    "claim_type": Database["public"]['Enums']["claim_type"],"created_at": string,"id": string,"insurer_id": string | null,"is_active": boolean,"name": string,"updated_at": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "claim_type": Database["public"]['Enums']["claim_type"],"created_at"?: string,"id"?: string,"insurer_id"?: string | null,"is_active"?: boolean,"name": string,"updated_at"?: string,"version"?: number
                  }
                  Update: {
                    "claim_type"?: Database["public"]['Enums']["claim_type"],"created_at"?: string,"id"?: string,"insurer_id"?: string | null,"is_active"?: boolean,"name"?: string,"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "checklist_templates_insurer_id_fkey"
      columns: ["insurer_id"]
isOneToOne: false
      referencedRelation: "insurers"
      referencedColumns: ["id"]
    }
                  ]
                },"device_outbox_status": {
                  Row: {
                    "device_id": string,"oldest_pending_at": string | null,"pending_bytes": number,"pending_count": number,"profile_id": string,"reported_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "device_id": string,"oldest_pending_at"?: string | null,"pending_bytes": number,"pending_count": number,"profile_id": string,"reported_at"?: string
                  }
                  Update: {
                    "device_id"?: string,"oldest_pending_at"?: string | null,"pending_bytes"?: number,"pending_count"?: number,"profile_id"?: string,"reported_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "device_outbox_status_device_id_fkey"
      columns: ["device_id"]
isOneToOne: true
      referencedRelation: "field_devices"
      referencedColumns: ["device_id"]
    },{
      foreignKeyName: "device_outbox_status_profile_id_fkey"
      columns: ["profile_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"device_tokens": {
                  Row: {
                    "platform": string,"token": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "platform"?: string,"token": string,"updated_at"?: string,"user_id"?: string
                  }
                  Update: {
                    "platform"?: string,"token"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "device_tokens_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"email_attachments": {
                  Row: {
                    "content_id": string | null,"created_at": string,"email_id": string,"filename": string,"id": string,"is_evidence": boolean,"is_inline": boolean,"mime_type": string | null,"ocr_text": string | null,"sha256": string,"size_bytes": number | null,"storage_path": string
                  }
                  ComputedFields: never
                  Insert: {
                    "content_id"?: string | null,"created_at"?: string,"email_id": string,"filename": string,"id"?: string,"is_evidence"?: boolean,"is_inline"?: boolean,"mime_type"?: string | null,"ocr_text"?: string | null,"sha256": string,"size_bytes"?: number | null,"storage_path": string
                  }
                  Update: {
                    "content_id"?: string | null,"created_at"?: string,"email_id"?: string,"filename"?: string,"id"?: string,"is_evidence"?: boolean,"is_inline"?: boolean,"mime_type"?: string | null,"ocr_text"?: string | null,"sha256"?: string,"size_bytes"?: number | null,"storage_path"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "email_attachments_email_id_fkey"
      columns: ["email_id"]
isOneToOne: false
      referencedRelation: "emails"
      referencedColumns: ["id"]
    }
                  ]
                },"emails": {
                  Row: {
                    "body_text": string | null,"case_id": string | null,"cc_addresses": (string)[],"classification": Database["public"]['Enums']["email_classification"],"created_at": string,"error": string | null,"from_address": string,"from_name": string | null,"gmail_message_id": string,"gmail_thread_id": string | null,"id": string,"in_reply_to": string | null,"insurer_id": string | null,"is_internal": boolean,"parse_notes": (string)[],"parser_version": string | null,"processed_at": string | null,"raw_sha256": string | null,"raw_storage_path": string | null,"received_at": string,"references_ids": (string)[],"retry_alerted_at": string | null,"retry_attempts": number,"retry_claimed_at": string | null,"retry_requested_at": string | null,"retry_requested_by": string | null,"status": Database["public"]['Enums']["email_status"],"subject": string | null,"template_id": string | null,"to_addresses": (string)[]
                  }
                  ComputedFields: never
                  Insert: {
                    "body_text"?: string | null,"case_id"?: string | null,"cc_addresses"?: (string)[],"classification"?: Database["public"]['Enums']["email_classification"],"created_at"?: string,"error"?: string | null,"from_address": string,"from_name"?: string | null,"gmail_message_id": string,"gmail_thread_id"?: string | null,"id"?: string,"in_reply_to"?: string | null,"insurer_id"?: string | null,"is_internal"?: boolean,"parse_notes"?: (string)[],"parser_version"?: string | null,"processed_at"?: string | null,"raw_sha256"?: string | null,"raw_storage_path"?: string | null,"received_at": string,"references_ids"?: (string)[],"retry_alerted_at"?: string | null,"retry_attempts"?: number,"retry_claimed_at"?: string | null,"retry_requested_at"?: string | null,"retry_requested_by"?: string | null,"status"?: Database["public"]['Enums']["email_status"],"subject"?: string | null,"template_id"?: string | null,"to_addresses"?: (string)[]
                  }
                  Update: {
                    "body_text"?: string | null,"case_id"?: string | null,"cc_addresses"?: (string)[],"classification"?: Database["public"]['Enums']["email_classification"],"created_at"?: string,"error"?: string | null,"from_address"?: string,"from_name"?: string | null,"gmail_message_id"?: string,"gmail_thread_id"?: string | null,"id"?: string,"in_reply_to"?: string | null,"insurer_id"?: string | null,"is_internal"?: boolean,"parse_notes"?: (string)[],"parser_version"?: string | null,"processed_at"?: string | null,"raw_sha256"?: string | null,"raw_storage_path"?: string | null,"received_at"?: string,"references_ids"?: (string)[],"retry_alerted_at"?: string | null,"retry_attempts"?: number,"retry_claimed_at"?: string | null,"retry_requested_at"?: string | null,"retry_requested_by"?: string | null,"status"?: Database["public"]['Enums']["email_status"],"subject"?: string | null,"template_id"?: string | null,"to_addresses"?: (string)[]
                  }
                  Relationships: [
                    {
      foreignKeyName: "emails_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "emails_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "emails_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    },{
      foreignKeyName: "emails_insurer_id_fkey"
      columns: ["insurer_id"]
isOneToOne: false
      referencedRelation: "insurers"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "emails_retry_requested_by_fkey"
      columns: ["retry_requested_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "emails_template_id_fkey"
      columns: ["template_id"]
isOneToOne: false
      referencedRelation: "case_templates"
      referencedColumns: ["id"]
    }
                  ]
                },"entities": {
                  Row: {
                    "address": string | null,"city": string | null,"created_at": string,"entity_type": Database["public"]['Enums']["entity_type"],"id": string,"name": string,"phone": string | null,"registration_no": string | null,"state": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"city"?: string | null,"created_at"?: string,"entity_type": Database["public"]['Enums']["entity_type"],"id"?: string,"name": string,"phone"?: string | null,"registration_no"?: string | null,"state"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "address"?: string | null,"city"?: string | null,"created_at"?: string,"entity_type"?: Database["public"]['Enums']["entity_type"],"id"?: string,"name"?: string,"phone"?: string | null,"registration_no"?: string | null,"state"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"evidence": {
                  Row: {
                    "archive_location": string | null,"archive_sha256_verified": boolean | null,"archived_at": string | null,"capture_source": Database["public"]['Enums']["capture_source"],"captured_by": string | null,"case_id": string,"checklist_item_id": string | null,"cloud_purged_at": string | null,"created_at": string,"device_captured_at": string | null,"device_info": NonNullable<Json>,"email_attachment_id": string | null,"evidence_type": Database["public"]['Enums']["evidence_type"],"exif": NonNullable<Json>,"flag_reason": string | null,"gps_accuracy_m": number | null,"id": string,"is_flagged": boolean,"latitude": number | null,"longitude": number | null,"message_id": string | null,"mime_type": string | null,"note_text": string | null,"original_filename": string | null,"relevance": Database["public"]['Enums']["evidence_relevance"],"relevance_at": string | null,"relevance_by": string | null,"server_received_at": string,"sha256": string | null,"size_bytes": number | null,"storage_backend": string,"storage_path": string | null,"task_id": string | null,"withdrawn_at": string | null,"withdrawn_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "archive_location"?: string | null,"archive_sha256_verified"?: boolean | null,"archived_at"?: string | null,"capture_source": Database["public"]['Enums']["capture_source"],"captured_by"?: string | null,"case_id": string,"checklist_item_id"?: string | null,"cloud_purged_at"?: string | null,"created_at"?: string,"device_captured_at"?: string | null,"device_info"?: NonNullable<Json>,"email_attachment_id"?: string | null,"evidence_type": Database["public"]['Enums']["evidence_type"],"exif"?: NonNullable<Json>,"flag_reason"?: string | null,"gps_accuracy_m"?: number | null,"id"?: string,"is_flagged"?: boolean,"latitude"?: number | null,"longitude"?: number | null,"message_id"?: string | null,"mime_type"?: string | null,"note_text"?: string | null,"original_filename"?: string | null,"relevance"?: Database["public"]['Enums']["evidence_relevance"],"relevance_at"?: string | null,"relevance_by"?: string | null,"server_received_at"?: string,"sha256"?: string | null,"size_bytes"?: number | null,"storage_backend"?: string,"storage_path"?: string | null,"task_id"?: string | null,"withdrawn_at"?: string | null,"withdrawn_by"?: string | null
                  }
                  Update: {
                    "archive_location"?: string | null,"archive_sha256_verified"?: boolean | null,"archived_at"?: string | null,"capture_source"?: Database["public"]['Enums']["capture_source"],"captured_by"?: string | null,"case_id"?: string,"checklist_item_id"?: string | null,"cloud_purged_at"?: string | null,"created_at"?: string,"device_captured_at"?: string | null,"device_info"?: NonNullable<Json>,"email_attachment_id"?: string | null,"evidence_type"?: Database["public"]['Enums']["evidence_type"],"exif"?: NonNullable<Json>,"flag_reason"?: string | null,"gps_accuracy_m"?: number | null,"id"?: string,"is_flagged"?: boolean,"latitude"?: number | null,"longitude"?: number | null,"message_id"?: string | null,"mime_type"?: string | null,"note_text"?: string | null,"original_filename"?: string | null,"relevance"?: Database["public"]['Enums']["evidence_relevance"],"relevance_at"?: string | null,"relevance_by"?: string | null,"server_received_at"?: string,"sha256"?: string | null,"size_bytes"?: number | null,"storage_backend"?: string,"storage_path"?: string | null,"task_id"?: string | null,"withdrawn_at"?: string | null,"withdrawn_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "evidence_captured_by_fkey"
      columns: ["captured_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    },{
      foreignKeyName: "evidence_checklist_item_id_fkey"
      columns: ["checklist_item_id"]
isOneToOne: false
      referencedRelation: "task_checklist_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_checklist_item_id_fkey"
      columns: ["checklist_item_id"]
isOneToOne: false
      referencedRelation: "v_case_checklist"
      referencedColumns: ["checklist_item_id"]
    },{
      foreignKeyName: "evidence_email_attachment_id_fkey"
      columns: ["email_attachment_id"]
isOneToOne: false
      referencedRelation: "email_attachments"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_message_id_fkey"
      columns: ["message_id"]
isOneToOne: false
      referencedRelation: "case_messages"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_relevance_by_fkey"
      columns: ["relevance_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_withdrawn_by_fkey"
      columns: ["withdrawn_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"evidence_categories": {
                  Row: {
                    "code": string,"created_at": string,"default_evidence_type": Database["public"]['Enums']["evidence_type"],"description": string | null,"filename_patterns": (string)[],"id": string,"is_active": boolean,"name": string,"needs_ocr": boolean,"text_patterns": (string)[],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"created_at"?: string,"default_evidence_type"?: Database["public"]['Enums']["evidence_type"],"description"?: string | null,"filename_patterns"?: (string)[],"id"?: string,"is_active"?: boolean,"name": string,"needs_ocr"?: boolean,"text_patterns"?: (string)[],"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"default_evidence_type"?: Database["public"]['Enums']["evidence_type"],"description"?: string | null,"filename_patterns"?: (string)[],"id"?: string,"is_active"?: boolean,"name"?: string,"needs_ocr"?: boolean,"text_patterns"?: (string)[],"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"evidence_derivatives": {
                  Row: {
                    "created_at": string,"evidence_id": string,"pixel_height": number | null,"pixel_width": number | null,"sha256": string,"size_bytes": number | null,"storage_path": string,"width": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"evidence_id": string,"pixel_height"?: number | null,"pixel_width"?: number | null,"sha256": string,"size_bytes"?: number | null,"storage_path": string,"width": number
                  }
                  Update: {
                    "created_at"?: string,"evidence_id"?: string,"pixel_height"?: number | null,"pixel_width"?: number | null,"sha256"?: string,"size_bytes"?: number | null,"storage_path"?: string,"width"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "evidence_derivatives_evidence_id_fkey"
      columns: ["evidence_id"]
isOneToOne: false
      referencedRelation: "evidence"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_derivatives_evidence_id_fkey"
      columns: ["evidence_id"]
isOneToOne: false
      referencedRelation: "v_evidence_processing"
      referencedColumns: ["evidence_id"]
    }
                  ]
                },"evidence_field_matches": {
                  Row: {
                    "created_at": string,"evidence_id": string,"field_id": string,"id": string,"model": string,"pipeline_version": string,"score": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"evidence_id": string,"field_id": string,"id"?: string,"model": string,"pipeline_version"?: string,"score": number
                  }
                  Update: {
                    "created_at"?: string,"evidence_id"?: string,"field_id"?: string,"id"?: string,"model"?: string,"pipeline_version"?: string,"score"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "evidence_field_matches_evidence_id_fkey"
      columns: ["evidence_id"]
isOneToOne: false
      referencedRelation: "evidence"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_field_matches_evidence_id_fkey"
      columns: ["evidence_id"]
isOneToOne: false
      referencedRelation: "v_evidence_processing"
      referencedColumns: ["evidence_id"]
    },{
      foreignKeyName: "evidence_field_matches_field_id_fkey"
      columns: ["field_id"]
isOneToOne: false
      referencedRelation: "case_template_fields"
      referencedColumns: ["id"]
    }
                  ]
                },"evidence_labels": {
                  Row: {
                    "category_id": string,"confidence": number | null,"created_at": string,"created_by": string | null,"description": string | null,"detail_reason": string | null,"evidence_id": string,"id": string,"is_active": boolean,"model": string | null,"needs_detail": boolean | null,"pipeline_version": string | null,"source": Database["public"]['Enums']["label_source"]
                  }
                  ComputedFields: never
                  Insert: {
                    "category_id": string,"confidence"?: number | null,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"detail_reason"?: string | null,"evidence_id": string,"id"?: string,"is_active"?: boolean,"model"?: string | null,"needs_detail"?: boolean | null,"pipeline_version"?: string | null,"source": Database["public"]['Enums']["label_source"]
                  }
                  Update: {
                    "category_id"?: string,"confidence"?: number | null,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"detail_reason"?: string | null,"evidence_id"?: string,"id"?: string,"is_active"?: boolean,"model"?: string | null,"needs_detail"?: boolean | null,"pipeline_version"?: string | null,"source"?: Database["public"]['Enums']["label_source"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "evidence_labels_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "evidence_categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_labels_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_labels_evidence_id_fkey"
      columns: ["evidence_id"]
isOneToOne: false
      referencedRelation: "evidence"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_labels_evidence_id_fkey"
      columns: ["evidence_id"]
isOneToOne: false
      referencedRelation: "v_evidence_processing"
      referencedColumns: ["evidence_id"]
    }
                  ]
                },"evidence_ocr": {
                  Row: {
                    "blocks": NonNullable<Json>,"created_at": string,"created_by": string | null,"engine": string,"engine_version": string | null,"evidence_id": string,"id": string,"is_current": boolean,"lang": string | null,"mean_confidence": number | null,"page_no": number,"text": string
                  }
                  ComputedFields: never
                  Insert: {
                    "blocks"?: NonNullable<Json>,"created_at"?: string,"created_by"?: string | null,"engine": string,"engine_version"?: string | null,"evidence_id": string,"id"?: string,"is_current"?: boolean,"lang"?: string | null,"mean_confidence"?: number | null,"page_no"?: number,"text": string
                  }
                  Update: {
                    "blocks"?: NonNullable<Json>,"created_at"?: string,"created_by"?: string | null,"engine"?: string,"engine_version"?: string | null,"evidence_id"?: string,"id"?: string,"is_current"?: boolean,"lang"?: string | null,"mean_confidence"?: number | null,"page_no"?: number,"text"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "evidence_ocr_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_ocr_evidence_id_fkey"
      columns: ["evidence_id"]
isOneToOne: false
      referencedRelation: "evidence"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_ocr_evidence_id_fkey"
      columns: ["evidence_id"]
isOneToOne: false
      referencedRelation: "v_evidence_processing"
      referencedColumns: ["evidence_id"]
    }
                  ]
                },"field_devices": {
                  Row: {
                    "device_id": string,"finished_at": string | null,"platform": string,"profile_id": string,"registered_at": string,"rotated_at": string | null,"secret_sha256": string
                  }
                  ComputedFields: never
                  Insert: {
                    "device_id": string,"finished_at"?: string | null,"platform"?: string,"profile_id": string,"registered_at"?: string,"rotated_at"?: string | null,"secret_sha256": string
                  }
                  Update: {
                    "device_id"?: string,"finished_at"?: string | null,"platform"?: string,"profile_id"?: string,"registered_at"?: string,"rotated_at"?: string | null,"secret_sha256"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "field_devices_profile_id_fkey"
      columns: ["profile_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"field_suggestions": {
                  Row: {
                    "block_index": number | null,"confidence": number | null,"created_at": string,"decided_at": string | null,"decided_by": string | null,"evidence_id": string,"field_id": string,"id": string,"ocr_id": string | null,"source": Database["public"]['Enums']["label_source"],"status": Database["public"]['Enums']["suggestion_status"],"value": string
                  }
                  ComputedFields: never
                  Insert: {
                    "block_index"?: number | null,"confidence"?: number | null,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"evidence_id": string,"field_id": string,"id"?: string,"ocr_id"?: string | null,"source"?: Database["public"]['Enums']["label_source"],"status"?: Database["public"]['Enums']["suggestion_status"],"value": string
                  }
                  Update: {
                    "block_index"?: number | null,"confidence"?: number | null,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"evidence_id"?: string,"field_id"?: string,"id"?: string,"ocr_id"?: string | null,"source"?: Database["public"]['Enums']["label_source"],"status"?: Database["public"]['Enums']["suggestion_status"],"value"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "field_suggestions_decided_by_fkey"
      columns: ["decided_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "field_suggestions_evidence_id_fkey"
      columns: ["evidence_id"]
isOneToOne: false
      referencedRelation: "evidence"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "field_suggestions_evidence_id_fkey"
      columns: ["evidence_id"]
isOneToOne: false
      referencedRelation: "v_evidence_processing"
      referencedColumns: ["evidence_id"]
    },{
      foreignKeyName: "field_suggestions_field_id_fkey"
      columns: ["field_id"]
isOneToOne: false
      referencedRelation: "case_template_fields"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "field_suggestions_ocr_id_fkey"
      columns: ["ocr_id"]
isOneToOne: false
      referencedRelation: "evidence_ocr"
      referencedColumns: ["id"]
    }
                  ]
                },"insurers": {
                  Row: {
                    "code": string,"created_at": string,"extraction_hints": NonNullable<Json>,"id": string,"is_active": boolean,"name": string,"portal_url": string | null,"reply_to_email": string | null,"report_template_path": string | null,"sender_domains": (string)[],"submission_channel": Database["public"]['Enums']["submission_channel"],"tat_days": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"created_at"?: string,"extraction_hints"?: NonNullable<Json>,"id"?: string,"is_active"?: boolean,"name": string,"portal_url"?: string | null,"reply_to_email"?: string | null,"report_template_path"?: string | null,"sender_domains"?: (string)[],"submission_channel"?: Database["public"]['Enums']["submission_channel"],"tat_days"?: number,"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"extraction_hints"?: NonNullable<Json>,"id"?: string,"is_active"?: boolean,"name"?: string,"portal_url"?: string | null,"reply_to_email"?: string | null,"report_template_path"?: string | null,"sender_domains"?: (string)[],"submission_channel"?: Database["public"]['Enums']["submission_channel"],"tat_days"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"intake_extractions": {
                  Row: {
                    "case_id": string | null,"created_at": string,"email_id": string,"extracted": NonNullable<Json>,"field_confidence": NonNullable<Json>,"id": string,"missing_required": (string)[],"model": string,"parser_action": string | null,"reject_reason": string | null,"reviewed_at": string | null,"reviewed_by": string | null,"status": Database["public"]['Enums']["extraction_status"],"template_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "case_id"?: string | null,"created_at"?: string,"email_id": string,"extracted": NonNullable<Json>,"field_confidence"?: NonNullable<Json>,"id"?: string,"missing_required"?: (string)[],"model": string,"parser_action"?: string | null,"reject_reason"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"status"?: Database["public"]['Enums']["extraction_status"],"template_id"?: string | null
                  }
                  Update: {
                    "case_id"?: string | null,"created_at"?: string,"email_id"?: string,"extracted"?: NonNullable<Json>,"field_confidence"?: NonNullable<Json>,"id"?: string,"missing_required"?: (string)[],"model"?: string,"parser_action"?: string | null,"reject_reason"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"status"?: Database["public"]['Enums']["extraction_status"],"template_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "intake_extractions_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "intake_extractions_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "intake_extractions_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    },{
      foreignKeyName: "intake_extractions_email_id_fkey"
      columns: ["email_id"]
isOneToOne: false
      referencedRelation: "emails"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "intake_extractions_reviewed_by_fkey"
      columns: ["reviewed_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "intake_extractions_template_id_fkey"
      columns: ["template_id"]
isOneToOne: false
      referencedRelation: "case_templates"
      referencedColumns: ["id"]
    }
                  ]
                },"notifications": {
                  Row: {
                    "body": string | null,"case_id": string | null,"created_at": string,"dedupe_key": string | null,"id": number,"kind": string,"read_at": string | null,"title": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body"?: string | null,"case_id"?: string | null,"created_at"?: string,"dedupe_key"?: string | null,"id"?: never,"kind": string,"read_at"?: string | null,"title": string,"user_id": string
                  }
                  Update: {
                    "body"?: string | null,"case_id"?: string | null,"created_at"?: string,"dedupe_key"?: string | null,"id"?: never,"kind"?: string,"read_at"?: string | null,"title"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notifications_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notifications_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notifications_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    },{
      foreignKeyName: "notifications_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"parties": {
                  Row: {
                    "address": string | null,"age": number | null,"case_id": string,"created_at": string,"id": string,"name": string,"notes": string | null,"phone": string | null,"role": Database["public"]['Enums']["party_role"]
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"age"?: number | null,"case_id": string,"created_at"?: string,"id"?: string,"name": string,"notes"?: string | null,"phone"?: string | null,"role": Database["public"]['Enums']["party_role"]
                  }
                  Update: {
                    "address"?: string | null,"age"?: number | null,"case_id"?: string,"created_at"?: string,"id"?: string,"name"?: string,"notes"?: string | null,"phone"?: string | null,"role"?: Database["public"]['Enums']["party_role"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "parties_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "parties_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "parties_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    }
                  ]
                },"processing_jobs": {
                  Row: {
                    "attempts": number,"created_at": string,"evidence_id": string,"finished_at": string | null,"id": number,"last_error": string | null,"locked_at": string | null,"locked_by": string | null,"max_attempts": number,"pipeline_version": string,"run_after": string,"stage": Database["public"]['Enums']["processing_stage"],"started_at": string | null,"status": Database["public"]['Enums']["job_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"created_at"?: string,"evidence_id": string,"finished_at"?: string | null,"id"?: never,"last_error"?: string | null,"locked_at"?: string | null,"locked_by"?: string | null,"max_attempts"?: number,"pipeline_version"?: string,"run_after"?: string,"stage": Database["public"]['Enums']["processing_stage"],"started_at"?: string | null,"status"?: Database["public"]['Enums']["job_status"]
                  }
                  Update: {
                    "attempts"?: number,"created_at"?: string,"evidence_id"?: string,"finished_at"?: string | null,"id"?: never,"last_error"?: string | null,"locked_at"?: string | null,"locked_by"?: string | null,"max_attempts"?: number,"pipeline_version"?: string,"run_after"?: string,"stage"?: Database["public"]['Enums']["processing_stage"],"started_at"?: string | null,"status"?: Database["public"]['Enums']["job_status"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "processing_jobs_evidence_id_fkey"
      columns: ["evidence_id"]
isOneToOne: false
      referencedRelation: "evidence"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "processing_jobs_evidence_id_fkey"
      columns: ["evidence_id"]
isOneToOne: false
      referencedRelation: "v_evidence_processing"
      referencedColumns: ["evidence_id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "availability": Database["public"]['Enums']["staff_availability"],"availability_until": string | null,"created_at": string,"deactivated_at": string | null,"full_name": string,"id": string,"is_active": boolean,"max_open_cases": number | null,"phone": string | null,"region": string | null,"role": Database["public"]['Enums']["user_role"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "availability"?: Database["public"]['Enums']["staff_availability"],"availability_until"?: string | null,"created_at"?: string,"deactivated_at"?: string | null,"full_name": string,"id": string,"is_active"?: boolean,"max_open_cases"?: number | null,"phone"?: string | null,"region"?: string | null,"role": Database["public"]['Enums']["user_role"],"updated_at"?: string
                  }
                  Update: {
                    "availability"?: Database["public"]['Enums']["staff_availability"],"availability_until"?: string | null,"created_at"?: string,"deactivated_at"?: string | null,"full_name"?: string,"id"?: string,"is_active"?: boolean,"max_open_cases"?: number | null,"phone"?: string | null,"region"?: string | null,"role"?: Database["public"]['Enums']["user_role"],"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"report_annexures": {
                  Row: {
                    "caption": string | null,"evidence_id": string,"position": number,"report_id": string,"section_key": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "caption"?: string | null,"evidence_id": string,"position": number,"report_id": string,"section_key"?: string | null
                  }
                  Update: {
                    "caption"?: string | null,"evidence_id"?: string,"position"?: number,"report_id"?: string,"section_key"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "report_annexures_evidence_id_fkey"
      columns: ["evidence_id"]
isOneToOne: false
      referencedRelation: "evidence"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "report_annexures_evidence_id_fkey"
      columns: ["evidence_id"]
isOneToOne: false
      referencedRelation: "v_evidence_processing"
      referencedColumns: ["evidence_id"]
    },{
      foreignKeyName: "report_annexures_report_id_fkey"
      columns: ["report_id"]
isOneToOne: false
      referencedRelation: "reports"
      referencedColumns: ["id"]
    }
                  ]
                },"report_approvals": {
                  Row: {
                    "case_id": string,"comments": string | null,"decided_at": string | null,"decided_by": string | null,"decision": Database["public"]['Enums']["approval_decision"],"id": string,"report_id": string,"requested_at": string,"requested_by": string
                  }
                  ComputedFields: never
                  Insert: {
                    "case_id": string,"comments"?: string | null,"decided_at"?: string | null,"decided_by"?: string | null,"decision"?: Database["public"]['Enums']["approval_decision"],"id"?: string,"report_id": string,"requested_at"?: string,"requested_by"?: string
                  }
                  Update: {
                    "case_id"?: string,"comments"?: string | null,"decided_at"?: string | null,"decided_by"?: string | null,"decision"?: Database["public"]['Enums']["approval_decision"],"id"?: string,"report_id"?: string,"requested_at"?: string,"requested_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "report_approvals_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "report_approvals_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "report_approvals_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    },{
      foreignKeyName: "report_approvals_decided_by_fkey"
      columns: ["decided_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "report_approvals_report_id_fkey"
      columns: ["report_id"]
isOneToOne: true
      referencedRelation: "reports"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "report_approvals_requested_by_fkey"
      columns: ["requested_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"report_files": {
                  Row: {
                    "created_at": string,"format": string,"report_id": string,"sha256": string | null,"size_bytes": number | null,"storage_path": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"format": string,"report_id": string,"sha256"?: string | null,"size_bytes"?: number | null,"storage_path": string
                  }
                  Update: {
                    "created_at"?: string,"format"?: string,"report_id"?: string,"sha256"?: string | null,"size_bytes"?: number | null,"storage_path"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "report_files_report_id_fkey"
      columns: ["report_id"]
isOneToOne: false
      referencedRelation: "reports"
      referencedColumns: ["id"]
    }
                  ]
                },"report_sends": {
                  Row: {
                    "attachment_name": string,"attempts": number,"body": string,"case_id": string,"cc_addresses": (string)[],"claimed_at": string | null,"delivery": string | null,"error": string | null,"formats": (string)[],"gmail_thread_id": string | null,"id": string,"in_reply_to": string | null,"link_expires_at": string | null,"message_id": string | null,"pack_path": string | null,"references_ids": (string)[],"report_id": string,"requested_at": string,"requested_by": string,"sent_at": string | null,"source_email_id": string | null,"status": string,"subject": string,"submission_id": string | null,"to_addresses": (string)[]
                  }
                  ComputedFields: never
                  Insert: {
                    "attachment_name": string,"attempts"?: number,"body": string,"case_id": string,"cc_addresses"?: (string)[],"claimed_at"?: string | null,"delivery"?: string | null,"error"?: string | null,"formats": (string)[],"gmail_thread_id"?: string | null,"id"?: string,"in_reply_to"?: string | null,"link_expires_at"?: string | null,"message_id"?: string | null,"pack_path"?: string | null,"references_ids"?: (string)[],"report_id": string,"requested_at"?: string,"requested_by"?: string,"sent_at"?: string | null,"source_email_id"?: string | null,"status"?: string,"subject": string,"submission_id"?: string | null,"to_addresses": (string)[]
                  }
                  Update: {
                    "attachment_name"?: string,"attempts"?: number,"body"?: string,"case_id"?: string,"cc_addresses"?: (string)[],"claimed_at"?: string | null,"delivery"?: string | null,"error"?: string | null,"formats"?: (string)[],"gmail_thread_id"?: string | null,"id"?: string,"in_reply_to"?: string | null,"link_expires_at"?: string | null,"message_id"?: string | null,"pack_path"?: string | null,"references_ids"?: (string)[],"report_id"?: string,"requested_at"?: string,"requested_by"?: string,"sent_at"?: string | null,"source_email_id"?: string | null,"status"?: string,"subject"?: string,"submission_id"?: string | null,"to_addresses"?: (string)[]
                  }
                  Relationships: [
                    {
      foreignKeyName: "report_sends_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "report_sends_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "report_sends_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    },{
      foreignKeyName: "report_sends_report_id_fkey"
      columns: ["report_id"]
isOneToOne: false
      referencedRelation: "reports"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "report_sends_requested_by_fkey"
      columns: ["requested_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "report_sends_source_email_id_fkey"
      columns: ["source_email_id"]
isOneToOne: false
      referencedRelation: "emails"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "report_sends_submission_id_fkey"
      columns: ["submission_id"]
isOneToOne: false
      referencedRelation: "submissions"
      referencedColumns: ["id"]
    }
                  ]
                },"reports": {
                  Row: {
                    "case_id": string,"created_at": string,"field_values": Json | null,"id": string,"notes": string | null,"origin": string,"status": Database["public"]['Enums']["report_status"],"storage_path": string,"template_id": string | null,"template_version": number | null,"uploaded_by": string,"values_token": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "case_id": string,"created_at"?: string,"field_values"?: Json | null,"id"?: string,"notes"?: string | null,"origin"?: string,"status"?: Database["public"]['Enums']["report_status"],"storage_path": string,"template_id"?: string | null,"template_version"?: number | null,"uploaded_by": string,"values_token"?: string | null,"version": number
                  }
                  Update: {
                    "case_id"?: string,"created_at"?: string,"field_values"?: Json | null,"id"?: string,"notes"?: string | null,"origin"?: string,"status"?: Database["public"]['Enums']["report_status"],"storage_path"?: string,"template_id"?: string | null,"template_version"?: number | null,"uploaded_by"?: string,"values_token"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "reports_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reports_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reports_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    },{
      foreignKeyName: "reports_template_id_fkey"
      columns: ["template_id"]
isOneToOne: false
      referencedRelation: "case_templates"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reports_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"submissions": {
                  Row: {
                    "ack_note": string | null,"acknowledged_at": string | null,"acknowledged_by": string | null,"case_id": string,"cc_addresses": (string)[],"channel": Database["public"]['Enums']["submission_channel"],"formats": (string)[],"gmail_thread_id": string | null,"id": string,"insurer_reference": string | null,"notes": string | null,"reopen_reason": string | null,"reopened_at": string | null,"reopened_by": string | null,"report_id": string,"sent_message_id": string | null,"submitted_at": string,"submitted_by": string,"to_addresses": (string)[]
                  }
                  ComputedFields: never
                  Insert: {
                    "ack_note"?: string | null,"acknowledged_at"?: string | null,"acknowledged_by"?: string | null,"case_id": string,"cc_addresses"?: (string)[],"channel": Database["public"]['Enums']["submission_channel"],"formats"?: (string)[],"gmail_thread_id"?: string | null,"id"?: string,"insurer_reference"?: string | null,"notes"?: string | null,"reopen_reason"?: string | null,"reopened_at"?: string | null,"reopened_by"?: string | null,"report_id": string,"sent_message_id"?: string | null,"submitted_at"?: string,"submitted_by": string,"to_addresses"?: (string)[]
                  }
                  Update: {
                    "ack_note"?: string | null,"acknowledged_at"?: string | null,"acknowledged_by"?: string | null,"case_id"?: string,"cc_addresses"?: (string)[],"channel"?: Database["public"]['Enums']["submission_channel"],"formats"?: (string)[],"gmail_thread_id"?: string | null,"id"?: string,"insurer_reference"?: string | null,"notes"?: string | null,"reopen_reason"?: string | null,"reopened_at"?: string | null,"reopened_by"?: string | null,"report_id"?: string,"sent_message_id"?: string | null,"submitted_at"?: string,"submitted_by"?: string,"to_addresses"?: (string)[]
                  }
                  Relationships: [
                    {
      foreignKeyName: "submissions_acknowledged_by_fkey"
      columns: ["acknowledged_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "submissions_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "submissions_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "submissions_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    },{
      foreignKeyName: "submissions_reopened_by_fkey"
      columns: ["reopened_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "submissions_report_id_fkey"
      columns: ["report_id"]
isOneToOne: false
      referencedRelation: "reports"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "submissions_submitted_by_fkey"
      columns: ["submitted_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"task_checklist_items": {
                  Row: {
                    "camera_only": boolean,"category_id": string | null,"completed_at": string | null,"description": string,"id": string,"is_mandatory": boolean,"note": string | null,"position": number,"required_evidence_type": Database["public"]['Enums']["evidence_type"],"source_template_item_id": string | null,"status": Database["public"]['Enums']["checklist_status"],"task_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "camera_only"?: boolean,"category_id"?: string | null,"completed_at"?: string | null,"description": string,"id"?: string,"is_mandatory"?: boolean,"note"?: string | null,"position": number,"required_evidence_type"?: Database["public"]['Enums']["evidence_type"],"source_template_item_id"?: string | null,"status"?: Database["public"]['Enums']["checklist_status"],"task_id": string,"updated_at"?: string
                  }
                  Update: {
                    "camera_only"?: boolean,"category_id"?: string | null,"completed_at"?: string | null,"description"?: string,"id"?: string,"is_mandatory"?: boolean,"note"?: string | null,"position"?: number,"required_evidence_type"?: Database["public"]['Enums']["evidence_type"],"source_template_item_id"?: string | null,"status"?: Database["public"]['Enums']["checklist_status"],"task_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_checklist_items_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "evidence_categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_checklist_items_source_template_item_id_fkey"
      columns: ["source_template_item_id"]
isOneToOne: false
      referencedRelation: "checklist_template_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_checklist_items_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"task_holds": {
                  Row: {
                    "held_from": string,"held_until": string | null,"id": number,"profile_id": string,"task_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "held_from"?: string,"held_until"?: string | null,"id"?: never,"profile_id": string,"task_id": string
                  }
                  Update: {
                    "held_from"?: string,"held_until"?: string | null,"id"?: never,"profile_id"?: string,"task_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_holds_profile_id_fkey"
      columns: ["profile_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_holds_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"tasks": {
                  Row: {
                    "assignee_id": string | null,"case_id": string,"completed_at": string | null,"created_at": string,"created_by": string | null,"due_at": string | null,"id": string,"instructions": string | null,"kind": Database["public"]['Enums']["task_kind"],"location_lat": number | null,"location_lng": number | null,"location_text": string | null,"parent_task_id": string | null,"reason": string | null,"started_at": string | null,"status": Database["public"]['Enums']["task_status"],"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assignee_id"?: string | null,"case_id": string,"completed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"due_at"?: string | null,"id"?: string,"instructions"?: string | null,"kind"?: Database["public"]['Enums']["task_kind"],"location_lat"?: number | null,"location_lng"?: number | null,"location_text"?: string | null,"parent_task_id"?: string | null,"reason"?: string | null,"started_at"?: string | null,"status"?: Database["public"]['Enums']["task_status"],"title": string,"updated_at"?: string
                  }
                  Update: {
                    "assignee_id"?: string | null,"case_id"?: string,"completed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"due_at"?: string | null,"id"?: string,"instructions"?: string | null,"kind"?: Database["public"]['Enums']["task_kind"],"location_lat"?: number | null,"location_lng"?: number | null,"location_text"?: string | null,"parent_task_id"?: string | null,"reason"?: string | null,"started_at"?: string | null,"status"?: Database["public"]['Enums']["task_status"],"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tasks_assignee_id_fkey"
      columns: ["assignee_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    },{
      foreignKeyName: "tasks_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_parent_task_id_fkey"
      columns: ["parent_task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            "v_case_checklist": {
                  Row: {
                    "case_id": string,"category_id": string | null,"checklist_item_id": string,"description": string,"evidence_count": number | null,"is_mandatory": boolean,"position": number,"status": Database["public"]['Enums']["checklist_status"],"task_id": string
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "task_checklist_items_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "evidence_categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_checklist_items_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    }
                  ]
                },"v_case_dashboard": {
                  Row: {
                    "active_assignees": string | null,"case_ref": string,"claim_type": Database["public"]['Enums']["claim_type"],"days_remaining": number | null,"due_at": string | null,"id": string,"insurer": string,"is_overdue": boolean | null,"open_tasks": number | null,"orchestrator": string | null,"received_at": string,"reinvestigation_rounds": number | null,"status": Database["public"]['Enums']["case_status"]
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                },"v_evidence_processing": {
                  Row: {
                    "case_id": string,"evidence_id": string,"state": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "evidence_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_case_dashboard"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "evidence_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "v_report_progress"
      referencedColumns: ["case_id"]
    }
                  ]
                },"v_report_progress": {
                  Row: {
                    "case_id": string,"entered": number | null,"fields_filled": number | null,"fields_total": number | null,"from_email": number | null,"from_suggestions": number | null,"last_updated_at": string | null,"last_updated_by": string | null,"position": number,"required_filled": number | null,"required_total": number | null,"section_id": string,"section_key": string,"title": string
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "activate_checklist_template":
{ Args: { "p_id": string }; Returns: undefined
                           },
"admin_list_users":
{ Args: { "p_user_id"?: string }; Returns: {
              "banned_until": string,"created_at": string,"email": string,"full_name": string,"id": string,"is_active": boolean,"last_sign_in_at": string,"phone": string,"profile_phone": string,"region": string,"role": Database["public"]['Enums']["user_role"],"updated_at": string
            }[]
                           },
"apply_checklist_template":
{ Args: { "p_task_id": string,"p_template_id": string }; Returns: number
                           },
"approve_own_report":
{ Args: { "p_comment"?: string,"p_report_id": string }; Returns: string
                           },
"can_upload_case_file":
{ Args: { "p_case_id": string }; Returns: boolean
                           },
"can_upload_evidence":
{ Args: { "p_task_id": string }; Returns: boolean
                           },
"can_upload_evidence_at":
{ Args: { "p_device_captured_at": string,"p_task_id": string }; Returns: boolean
                           },
"cancel_field_task":
{ Args: { "p_reason": string,"p_task_id": string }; Returns: undefined
                           },
"case_field_history":
{ Args: { "p_case_id": string }; Returns: {
              "action": string,"actor_id": string,"actor_name": string,"changed_at": string,"field_key": string,"new_value": string,"old_value": string,"source": string
            }[]
                           },
"case_outbox_status":
{ Args: { "p_case_id": string }; Returns: {
              "device_id": string,"full_name": string,"is_active": boolean,"oldest_pending_at": string,"pending_bytes": number,"pending_count": number,"profile_id": string,"reported_at": string
            }[]
                           },
"case_thread_state":
{ Args: { "p_case_id": string }; Returns: {
              "field_last_read_at": string,"staff_last_read_at": string
            }[]
                           },
"claim_intake_retries":
{ Args: { "p_limit"?: number }; Returns: {
              "id": string,"raw_storage_path": string
            }[]
                           },
"claim_processing_jobs":
{ Args: { "p_limit": number,"p_stages": (Database["public"]['Enums']["processing_stage"])[],"p_worker": string }; Returns: {
              "attempts": number,
"created_at": string,
"evidence_id": string,
"finished_at": string | null,
"id": number,
"last_error": string | null,
"locked_at": string | null,
"locked_by": string | null,
"max_attempts": number,
"pipeline_version": string,
"run_after": string,
"stage": Database["public"]['Enums']["processing_stage"],
"started_at": string | null,
"status": Database["public"]['Enums']["job_status"]
            }[]
                          SetofOptions: {
        from: "*"
        to: "processing_jobs"
        isOneToOne: false
        isSetofReturn: true
      } },
"claim_report_send":
{ Args: { "p_id": string,"p_message_id": string }; Returns: {
              "attachment_name": string,"body": string,"case_id": string,"case_ref": string,"cc_addresses": (string)[],"formats": (string)[],"id": string,"in_reply_to": string,"message_id": string,"references_ids": (string)[],"report_id": string,"subject": string,"to_addresses": (string)[]
            }[]
                           },
"complete_processing_job":
{ Args: { "p_error"?: string,"p_job_id": number,"p_status": Database["public"]['Enums']["job_status"] }; Returns: undefined
                           },
"complete_report_send":
{ Args: { "p_delivery": string,"p_id": string,"p_link_expires": string,"p_pack_path": string }; Returns: string
                           },
"confirm_intake":
{ Args: { "p_extraction_id": string,"p_template_id": string,"p_values": Json }; Returns: string
                           },
"create_case_direct":
{ Args: { "p_note"?: string,"p_owner_id"?: string,"p_template_id": string,"p_values": Json }; Returns: {
              "case_id": string,"case_ref": string
            }[]
                           },
"create_field_task":
{ Args: { "p_assignee_id": string,"p_case_id": string,"p_checklist_template_id"?: string,"p_due_at"?: string,"p_instructions"?: string,"p_kind"?: Database["public"]['Enums']["task_kind"],"p_location_text"?: string,"p_parent_task_id"?: string,"p_reason"?: string,"p_title": string }; Returns: string
                           },
"create_report_version":
{ Args: { "p_case_id": string,"p_files": Json,"p_notes"?: string,"p_photos": Json,"p_report_id": string,"p_values_token": string }; Returns: Json
                           },
"device_derivative_target":
{ Args: { "p_originals": (string)[],"p_task_id": string }; Returns: Json
                           },
"drain_authorize_upload":
{ Args: { "p_device_captured_at": string,"p_device_id": string,"p_secret": string,"p_sha256": string,"p_task_id": string }; Returns: string
                           },
"drain_check":
{ Args: { "p_action"?: string,"p_device_id": string,"p_secret": string }; Returns: {
              "result": string,"retry_after_seconds": number
            }[]
                           },
"drain_finish":
{ Args: { "p_device_id": string,"p_discarded_count"?: number,"p_secret": string }; Returns: undefined
                           },
"drain_post_message":
{ Args: { "p_body"?: string,"p_case_id": string,"p_client_message_id": string,"p_device_id": string,"p_items"?: Json,"p_kind": Database["public"]['Enums']["message_kind"],"p_reply_to"?: string,"p_secret": string,"p_task_id"?: string }; Returns: string
                           },
"drain_report_outbox":
{ Args: { "p_device_id": string,"p_oldest_pending_at"?: string,"p_pending_bytes": number,"p_pending_count": number,"p_secret": string }; Returns: undefined
                           },
"drain_status":
{ Args: { "p_device_id": string,"p_secret": string }; Returns: {
              "deactivated_at": string,"drain_until": string,"state": string
            }[]
                           },
"enqueue_reprocessing":
{ Args: { "p_evidence_ids": (string)[],"p_pipeline_version": string,"p_stages": (Database["public"]['Enums']["processing_stage"])[] }; Returns: number
                           },
"escalate_stuck_intake_retries":
{ Args: Record<PropertyKey, never>; Returns: {
              "email_id": string,"email_status": Database["public"]['Enums']["email_status"],"from_address": string,"received_at": string,"retry_attempts": number,"retry_requested_at": string,"subject": string
            }[]
                           },
"escalate_unattended_cases":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"evidence_purge_candidates":
{ Args: { "p_days"?: number }; Returns: {
              "archive_location": string,"archived_at": string,"case_id": string,"evidence_id": string,"last_submitted_at": string,"storage_backend": string,"storage_path": string
            }[]
                           },
"evidence_upload_target":
{ Args: { "p_sha256": (string)[],"p_task_id": string }; Returns: {
              "case_id": string,"stored_sha256": (string)[]
            }[]
                           },
"fail_report_send":
{ Args: { "p_ambiguous"?: boolean,"p_error": string,"p_id": string }; Returns: undefined
                           },
"field_case_list":
{ Args: Record<PropertyKey, never>; Returns: {
              "case_id": string,"case_ref": string,"claim_type": Database["public"]['Enums']["claim_type"],"insurer_name": string,"last_message_at": string,"last_message_preview": string,"list": string,"title": string,"unread_count": number
            }[]
                           },
"intake_config":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"intake_confirmed_case_ref":
{ Args: { "p_extraction_id": string }; Returns: string
                           },
"intake_ingest":
{ Args: { "p": Json }; Returns: Json
                           },
"intake_record_failure":
{ Args: { "p_error": string,"p_from"?: string,"p_message_id": string,"p_raw_storage_path": string,"p_subject"?: string }; Returns: string
                           },
"intake_retry":
{ Args: { "p_email_id": string }; Returns: string
                           },
"intake_retry_failed":
{ Args: { "p_email_id": string,"p_error": string }; Returns: boolean
                           },
"is_admin":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"is_field":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"is_staff":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"load_case_template":
{ Args: { "p_activate"?: boolean,"p_config": Json,"p_source_file"?: string }; Returns: {
              "created": boolean,"template_id": string,"version": number
            }[]
                           },
"load_evidence_categories":
{ Args: { "p_categories": Json }; Returns: number
                           },
"mark_thread_read":
{ Args: { "p_case_id": string }; Returns: undefined
                           },
"ocr_wanted":
{ Args: { "p_evidence_id": string }; Returns: boolean
                           },
"post_staff_note":
{ Args: { "p_body": string,"p_case_id": string,"p_client_message_id": string,"p_reply_to"?: string }; Returns: string
                           },
"post_thread_message":
{ Args: { "p_body"?: string,"p_case_id": string,"p_client_message_id": string,"p_items"?: Json,"p_kind": Database["public"]['Enums']["message_kind"],"p_reply_to"?: string,"p_task_id"?: string }; Returns: string
                           },
"prepare_report_version":
{ Args: { "p_case_id": string }; Returns: Json
                           },
"reassign_case":
{ Args: { "p_assignee_id": string,"p_case_id": string,"p_reason": string }; Returns: undefined
                           },
"reassign_field_task":
{ Args: { "p_assignee_id": string,"p_reason": string,"p_task_id": string }; Returns: undefined
                           },
"record_device_derivative":
{ Args: { "p_case_id": string,"p_original_sha256": string,"p_pixel_height": number,"p_pixel_width": number,"p_sha256": string,"p_size_bytes": number,"p_storage_path": string,"p_width": number }; Returns: Json
                           },
"record_manual_submission":
{ Args: { "p_case_id": string,"p_channel": Database["public"]['Enums']["submission_channel"],"p_formats": (string)[],"p_insurer_reference": string,"p_note": string,"p_report_id"?: string,"p_submitted_at"?: string }; Returns: string
                           },
"record_submission_ack":
{ Args: { "p_ack_at": string,"p_insurer_reference"?: string,"p_note": string,"p_submission_id": string }; Returns: undefined
                           },
"register_field_device":
{ Args: { "p_device_id": string,"p_platform"?: string,"p_secret_sha256": string }; Returns: undefined
                           },
"reject_intake":
{ Args: { "p_extraction_id": string,"p_reason": string }; Returns: undefined
                           },
"reopen_case":
{ Args: { "p_case_id": string,"p_reason": string }; Returns: undefined
                           },
"report_outbox_status":
{ Args: { "p_device_id": string,"p_oldest_pending_at"?: string,"p_pending_bytes": number,"p_pending_count": number }; Returns: undefined
                           },
"report_send_target":
{ Args: { "p_case_id": string }; Returns: {
              "cc_addresses": (string)[],"email_id": string,"gmail_thread_id": string,"in_reply_to": string,"original_subject": string,"references_ids": (string)[],"to_addresses": (string)[]
            }[]
                           },
"request_intake_retry":
{ Args: { "p_email_id": string }; Returns: string
                           },
"request_portal_pack":
{ Args: { "p_case_id": string,"p_formats": (string)[] }; Returns: string
                           },
"request_report_send":
{ Args: { "p_attachment_name": string,"p_body": string,"p_case_id": string,"p_cc": (string)[],"p_formats": (string)[],"p_subject": string,"p_to": (string)[] }; Returns: string
                           },
"resolve_report_send":
{ Args: { "p_id": string,"p_sent_at"?: string,"p_was_sent": boolean }; Returns: undefined
                           },
"retry_auto_assign":
{ Args: { "p_case_id": string }; Returns: string
                           },
"retry_report_send":
{ Args: { "p_id": string }; Returns: undefined
                           },
"save_case_field_values":
{ Args: { "p_case_id": string,"p_expected": Json,"p_values": Json }; Returns: Json
                           },
"save_checklist_template":
{ Args: { "p_claim_type": Database["public"]['Enums']["claim_type"],"p_expected_version": number,"p_insurer_id": string,"p_items": Json,"p_name": string,"p_template_id": string }; Returns: {
              "id": string,"version": number
            }[]
                           },
"set_availability":
{ Args: { "p_availability": Database["public"]['Enums']["staff_availability"],"p_until"?: string,"p_user_id": string }; Returns: undefined
                           },
"set_evidence_labels":
{ Args: { "p_category_ids": (string)[],"p_evidence_id": string }; Returns: undefined
                           },
"update_field_task":
{ Args: { "p_due_at"?: string,"p_instructions"?: string,"p_location_text"?: string,"p_task_id": string,"p_title": string }; Returns: boolean
                           },
"withdraw_message":
{ Args: { "p_message_id": string }; Returns: undefined
                           }
          }
          Enums: {
            "approval_decision": "pending"|"approved"|"changes_requested","assignment_strategy": "least_loaded"|"round_robin","capture_source": "camera"|"gallery"|"share"|"web_upload"|"email_attachment","case_status": "received"|"intake_confirmed"|"assigned"|"field_in_progress"|"office_review"|"orchestrator_review"|"submitted"|"closed"|"cancelled","checklist_status": "pending"|"captured"|"not_available"|"waived","claim_type": "health"|"motor"|"death"|"personal_accident"|"property"|"other","email_classification": "unclassified"|"new_case"|"reminder"|"additional_docs"|"query"|"other","email_status": "pending"|"processing"|"processed"|"failed"|"retry_requested"|"ignored","entity_type": "hospital"|"garage"|"doctor"|"agent"|"police_station"|"other","evidence_relevance": "unreviewed"|"relevant"|"not_relevant","evidence_type": "photo"|"document"|"audio"|"video"|"note","extraction_status": "pending_review"|"confirmed"|"rejected","field_value_source": "email_parser"|"llm"|"office"|"suggestion","job_status": "queued"|"running"|"done"|"failed"|"skipped","label_source": "operator"|"filename_rule"|"text_rule"|"model"|"llm"|"human","message_kind": "text"|"media"|"voice"|"system"|"request","party_role": "insured"|"patient"|"claimant"|"nominee"|"driver"|"witness"|"other","processing_stage": "text_extract"|"ocr"|"label"|"field_suggest","report_status": "draft"|"final","staff_availability": "available"|"on_leave"|"unavailable","submission_channel": "email"|"portal"|"other","suggestion_status": "pending"|"accepted"|"rejected","task_kind": "initial"|"re_investigation"|"office"|"other","task_status": "pending"|"in_progress"|"completed"|"cancelled","template_field_source": "intake"|"office","template_field_type": "text"|"long_text"|"number"|"currency"|"date"|"datetime"|"choice"|"multi_choice"|"boolean","user_role": "admin"|"orchestrator"|"office"|"field"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            "approval_decision": ["pending", "approved", "changes_requested"],"assignment_strategy": ["least_loaded", "round_robin"],"capture_source": ["camera", "gallery", "share", "web_upload", "email_attachment"],"case_status": ["received", "intake_confirmed", "assigned", "field_in_progress", "office_review", "orchestrator_review", "submitted", "closed", "cancelled"],"checklist_status": ["pending", "captured", "not_available", "waived"],"claim_type": ["health", "motor", "death", "personal_accident", "property", "other"],"email_classification": ["unclassified", "new_case", "reminder", "additional_docs", "query", "other"],"email_status": ["pending", "processing", "processed", "failed", "retry_requested", "ignored"],"entity_type": ["hospital", "garage", "doctor", "agent", "police_station", "other"],"evidence_relevance": ["unreviewed", "relevant", "not_relevant"],"evidence_type": ["photo", "document", "audio", "video", "note"],"extraction_status": ["pending_review", "confirmed", "rejected"],"field_value_source": ["email_parser", "llm", "office", "suggestion"],"job_status": ["queued", "running", "done", "failed", "skipped"],"label_source": ["operator", "filename_rule", "text_rule", "model", "llm", "human"],"message_kind": ["text", "media", "voice", "system", "request"],"party_role": ["insured", "patient", "claimant", "nominee", "driver", "witness", "other"],"processing_stage": ["text_extract", "ocr", "label", "field_suggest"],"report_status": ["draft", "final"],"staff_availability": ["available", "on_leave", "unavailable"],"submission_channel": ["email", "portal", "other"],"suggestion_status": ["pending", "accepted", "rejected"],"task_kind": ["initial", "re_investigation", "office", "other"],"task_status": ["pending", "in_progress", "completed", "cancelled"],"template_field_source": ["intake", "office"],"template_field_type": ["text", "long_text", "number", "currency", "date", "datetime", "choice", "multi_choice", "boolean"],"user_role": ["admin", "orchestrator", "office", "field"]
          }
        }
} as const
