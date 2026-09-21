export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      addresses: {
        Row: {
          city: string | null
          country: string
          created_at: string
          customer_id: string
          id: string
          is_default: boolean
          label: string
          line1: string
          line2: string | null
          phone: string | null
          postal_code: string | null
          recipient_name: string
          region: string | null
          updated_at: string
        }
        Insert: {
          city?: string | null
          country: string
          created_at?: string
          customer_id?: string
          id?: string
          is_default?: boolean
          label?: string
          line1: string
          line2?: string | null
          phone?: string | null
          postal_code?: string | null
          recipient_name: string
          region?: string | null
          updated_at?: string
        }
        Update: {
          city?: string | null
          country?: string
          created_at?: string
          customer_id?: string
          id?: string
          is_default?: boolean
          label?: string
          line1?: string
          line2?: string | null
          phone?: string | null
          postal_code?: string | null
          recipient_name?: string
          region?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "addresses_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      categories: {
        Row: {
          created_at: string
          description: string
          id: string
          image_url: string | null
          is_active: boolean
          name: string
          parent_id: string | null
          position: number
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string
          id?: string
          image_url?: string | null
          is_active?: boolean
          name: string
          parent_id?: string | null
          position?: number
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          image_url?: string | null
          is_active?: boolean
          name?: string
          parent_id?: string | null
          position?: number
          slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          anonymized_at: string | null
          auth_user_id: string | null
          created_at: string
          email: string | null
          full_name: string
          id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          anonymized_at?: string | null
          auth_user_id?: string | null
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          anonymized_at?: string | null
          auth_user_id?: string | null
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      discount_redemptions: {
        Row: {
          created_at: string
          customer_id: string
          id: string
          order_id: string | null
          promotion_id: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          id?: string
          order_id?: string | null
          promotion_id: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          id?: string
          order_id?: string | null
          promotion_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discount_redemptions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discount_redemptions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discount_redemptions_promotion_id_fkey"
            columns: ["promotion_id"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id"]
          },
        ]
      }
      fulfillments: {
        Row: {
          carrier: string
          created_at: string
          delivered_at: string | null
          id: string
          items: Json
          order_id: string
          shipped_at: string | null
          status: string
          tracking_number: string
          tracking_url: string | null
          updated_at: string
          version: number
        }
        Insert: {
          carrier?: string
          created_at?: string
          delivered_at?: string | null
          id?: string
          items: Json
          order_id: string
          shipped_at?: string | null
          status?: string
          tracking_number?: string
          tracking_url?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          carrier?: string
          created_at?: string
          delivered_at?: string | null
          id?: string
          items?: Json
          order_id?: string
          shipped_at?: string | null
          status?: string
          tracking_number?: string
          tracking_url?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "fulfillments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_levels: {
        Row: {
          location_id: string
          on_hand: number
          reservation_revision: number
          variant_id: string
        }
        Insert: {
          location_id: string
          on_hand?: number
          reservation_revision?: number
          variant_id: string
        }
        Update: {
          location_id?: string
          on_hand?: number
          reservation_revision?: number
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_levels_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_levels_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_movements: {
        Row: {
          actor_id: string | null
          created_at: string
          delta: number
          id: number
          location_id: string
          note: string | null
          on_hand_after: number
          order_id: string | null
          reason: string
          transfer_id: string | null
          variant_id: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          delta: number
          id?: never
          location_id: string
          note?: string | null
          on_hand_after: number
          order_id?: string | null
          reason: string
          transfer_id?: string | null
          variant_id: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          delta?: number
          id?: never
          location_id?: string
          note?: string | null
          on_hand_after?: number
          order_id?: string | null
          reason?: string
          transfer_id?: string | null
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_movements_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          address: Json | null
          code: string
          created_at: string
          id: string
          is_active: boolean
          is_default: boolean
          name: string
          revision: number
        }
        Insert: {
          address?: Json | null
          code: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name: string
          revision?: number
        }
        Update: {
          address?: Json | null
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name?: string
          revision?: number
        }
        Relationships: []
      }
      metafield_definitions: {
        Row: {
          access: string
          created_at: string
          description: string
          id: string
          key: string
          name: string
          namespace: string
          owner_type: string
          position: number
          revision: number
          type: string
          updated_at: string
          validations: Json
        }
        Insert: {
          access?: string
          created_at?: string
          description?: string
          id?: string
          key: string
          name: string
          namespace?: string
          owner_type: string
          position?: number
          revision?: number
          type: string
          updated_at?: string
          validations?: Json
        }
        Update: {
          access?: string
          created_at?: string
          description?: string
          id?: string
          key?: string
          name?: string
          namespace?: string
          owner_type?: string
          position?: number
          revision?: number
          type?: string
          updated_at?: string
          validations?: Json
        }
        Relationships: []
      }
      metafields: {
        Row: {
          created_at: string
          id: string
          key: string
          namespace: string
          owner_category_id: string | null
          owner_customer_id: string | null
          owner_id: string
          owner_order_id: string | null
          owner_product_id: string | null
          owner_type: string
          owner_variant_id: string | null
          revision: number
          type: string
          updated_at: string
          value: Json
        }
        Insert: {
          created_at?: string
          id?: string
          key: string
          namespace?: string
          owner_category_id?: string | null
          owner_customer_id?: string | null
          owner_id: string
          owner_order_id?: string | null
          owner_product_id?: string | null
          owner_type: string
          owner_variant_id?: string | null
          revision?: number
          type: string
          updated_at?: string
          value: Json
        }
        Update: {
          created_at?: string
          id?: string
          key?: string
          namespace?: string
          owner_category_id?: string | null
          owner_customer_id?: string | null
          owner_id?: string
          owner_order_id?: string | null
          owner_product_id?: string | null
          owner_type?: string
          owner_variant_id?: string | null
          revision?: number
          type?: string
          updated_at?: string
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "metafields_owner_category_id_fkey"
            columns: ["owner_category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metafields_owner_customer_id_fkey"
            columns: ["owner_customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metafields_owner_order_id_fkey"
            columns: ["owner_order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metafields_owner_product_id_fkey"
            columns: ["owner_product_id"]
            isOneToOne: false
            referencedRelation: "product_listing"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metafields_owner_product_id_fkey"
            columns: ["owner_product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metafields_owner_variant_id_fkey"
            columns: ["owner_variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      metaobject_definitions: {
        Row: {
          access: string
          created_at: string
          description: string
          fields: Json
          id: string
          is_active: boolean
          name: string
          revision: number
          type: string
          updated_at: string
        }
        Insert: {
          access?: string
          created_at?: string
          description?: string
          fields: Json
          id?: string
          is_active?: boolean
          name: string
          revision?: number
          type: string
          updated_at?: string
        }
        Update: {
          access?: string
          created_at?: string
          description?: string
          fields?: Json
          id?: string
          is_active?: boolean
          name?: string
          revision?: number
          type?: string
          updated_at?: string
        }
        Relationships: []
      }
      metaobjects: {
        Row: {
          created_at: string
          definition_id: string
          handle: string
          id: string
          revision: number
          status: string
          updated_at: string
          values: Json
        }
        Insert: {
          created_at?: string
          definition_id: string
          handle: string
          id?: string
          revision?: number
          status?: string
          updated_at?: string
          values?: Json
        }
        Update: {
          created_at?: string
          definition_id?: string
          handle?: string
          id?: string
          revision?: number
          status?: string
          updated_at?: string
          values?: Json
        }
        Relationships: [
          {
            foreignKeyName: "metaobjects_definition_id_fkey"
            columns: ["definition_id"]
            isOneToOne: false
            referencedRelation: "metaobject_definitions"
            referencedColumns: ["id"]
          },
        ]
      }
      order_events: {
        Row: {
          actor_id: string | null
          created_at: string
          data: Json
          id: number
          order_id: string
          type: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          data?: Json
          id?: never
          order_id: string
          type: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          data?: Json
          id?: never
          order_id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_events_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          attributes: Json
          discount_total: number
          id: string
          line_key: string
          line_total: number | null
          name: string
          options: Json
          order_id: string
          product_id: string | null
          quantity: number
          refunded_amount: number
          refunded_quantity: number
          sku: string | null
          total: number
          unit_price: number
          variant_id: string | null
          variant_title: string
        }
        Insert: {
          attributes?: Json
          discount_total?: number
          id?: string
          line_key?: string
          line_total?: number | null
          name: string
          options?: Json
          order_id: string
          product_id?: string | null
          quantity: number
          refunded_amount?: number
          refunded_quantity?: number
          sku?: string | null
          total: number
          unit_price: number
          variant_id?: string | null
          variant_title?: string
        }
        Update: {
          attributes?: Json
          discount_total?: number
          id?: string
          line_key?: string
          line_total?: number | null
          name?: string
          options?: Json
          order_id?: string
          product_id?: string | null
          quantity?: number
          refunded_amount?: number
          refunded_quantity?: number
          sku?: string | null
          total?: number
          unit_price?: number
          variant_id?: string | null
          variant_title?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_listing"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      order_promotions: {
        Row: {
          amount: number
          code: string | null
          created_at: string
          name: string
          order_id: string
          promotion_id: string
          snapshot: Json
        }
        Insert: {
          amount: number
          code?: string | null
          created_at?: string
          name: string
          order_id: string
          promotion_id: string
          snapshot?: Json
        }
        Update: {
          amount?: number
          code?: string | null
          created_at?: string
          name?: string
          order_id?: string
          promotion_id?: string
          snapshot?: Json
        }
        Relationships: [
          {
            foreignKeyName: "order_promotions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_promotions_promotion_id_fkey"
            columns: ["promotion_id"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          admin_note: string | null
          billing_address: Json | null
          cancel_reason: string | null
          cancelled_at: string | null
          completed_at: string | null
          created_at: string
          currency: string
          customer_id: string
          customer_note: string | null
          discount_code: string | null
          discount_total: number
          email: string
          financial_status: string
          fulfillment_status: string
          id: string
          order_number: number
          paid_at: string | null
          payment_expires_at: string
          shipping_address: Json
          shipping_method_id: string | null
          shipping_method_name: string | null
          shipping_total: number
          status: string
          subtotal: number
          tax_context: Json
          tax_total: number
          total: number
          updated_at: string
        }
        Insert: {
          admin_note?: string | null
          billing_address?: Json | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          created_at?: string
          currency?: string
          customer_id: string
          customer_note?: string | null
          discount_code?: string | null
          discount_total?: number
          email: string
          financial_status?: string
          fulfillment_status?: string
          id?: string
          order_number?: never
          paid_at?: string | null
          payment_expires_at?: string
          shipping_address: Json
          shipping_method_id?: string | null
          shipping_method_name?: string | null
          shipping_total?: number
          status?: string
          subtotal: number
          tax_context?: Json
          tax_total?: number
          total: number
          updated_at?: string
        }
        Update: {
          admin_note?: string | null
          billing_address?: Json | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          created_at?: string
          currency?: string
          customer_id?: string
          customer_note?: string | null
          discount_code?: string | null
          discount_total?: number
          email?: string
          financial_status?: string
          fulfillment_status?: string
          id?: string
          order_number?: never
          paid_at?: string | null
          payment_expires_at?: string
          shipping_address?: Json
          shipping_method_id?: string | null
          shipping_method_name?: string | null
          shipping_total?: number
          status?: string
          subtotal?: number
          tax_context?: Json
          tax_total?: number
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_shipping_method_id_fkey"
            columns: ["shipping_method_id"]
            isOneToOne: false
            referencedRelation: "shipping_methods"
            referencedColumns: ["id"]
          },
        ]
      }
      product_categories: {
        Row: {
          category_id: string
          product_id: string
        }
        Insert: {
          category_id: string
          product_id: string
        }
        Update: {
          category_id?: string
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_categories_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_categories_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_listing"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_categories_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_images: {
        Row: {
          alt: string
          id: string
          position: number
          product_id: string
          url: string
          variant_id: string | null
        }
        Insert: {
          alt?: string
          id?: string
          position?: number
          product_id: string
          url: string
          variant_id?: string | null
        }
        Update: {
          alt?: string
          id?: string
          position?: number
          product_id?: string
          url?: string
          variant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_images_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_listing"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_images_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_images_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      product_option_values: {
        Row: {
          id: string
          option_id: string
          position: number
          value: string
        }
        Insert: {
          id?: string
          option_id: string
          position?: number
          value: string
        }
        Update: {
          id?: string
          option_id?: string
          position?: number
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_option_values_option_id_fkey"
            columns: ["option_id"]
            isOneToOne: false
            referencedRelation: "product_options"
            referencedColumns: ["id"]
          },
        ]
      }
      product_options: {
        Row: {
          id: string
          name: string
          position: number
          product_id: string
        }
        Insert: {
          id?: string
          name: string
          position?: number
          product_id: string
        }
        Update: {
          id?: string
          name?: string
          position?: number
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_options_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_listing"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_options_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_reviews: {
        Row: {
          body: string
          created_at: string
          customer_id: string
          id: string
          product_id: string
          rating: number
          revision: number
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          body?: string
          created_at?: string
          customer_id?: string
          id?: string
          product_id: string
          rating: number
          revision?: number
          status?: string
          title?: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          customer_id?: string
          id?: string
          product_id?: string
          rating?: number
          revision?: number
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_reviews_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_reviews_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_listing"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_reviews_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_variants: {
        Row: {
          barcode: string | null
          compare_at_price: number | null
          cost: number | null
          created_at: string
          id: string
          is_active: boolean
          position: number
          price: number
          product_id: string
          sku: string | null
          track_inventory: boolean
          updated_at: string
        }
        Insert: {
          barcode?: string | null
          compare_at_price?: number | null
          cost?: number | null
          created_at?: string
          id?: string
          is_active?: boolean
          position?: number
          price: number
          product_id: string
          sku?: string | null
          track_inventory?: boolean
          updated_at?: string
        }
        Update: {
          barcode?: string | null
          compare_at_price?: number | null
          cost?: number | null
          created_at?: string
          id?: string
          is_active?: boolean
          position?: number
          price?: number
          product_id?: string
          sku?: string | null
          track_inventory?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_variants_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_listing"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_variants_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          created_at: string
          description: string
          id: string
          name: string
          product_type: string
          revision: number
          seo_description: string | null
          seo_title: string | null
          slug: string
          status: string
          tags: string[]
          updated_at: string
          vendor: string
        }
        Insert: {
          created_at?: string
          description?: string
          id?: string
          name: string
          product_type?: string
          revision?: number
          seo_description?: string | null
          seo_title?: string | null
          slug: string
          status?: string
          tags?: string[]
          updated_at?: string
          vendor?: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          name?: string
          product_type?: string
          revision?: number
          seo_description?: string | null
          seo_title?: string | null
          slug?: string
          status?: string
          tags?: string[]
          updated_at?: string
          vendor?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          id: string
          role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string
          id: string
          role?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
      promotion_targets: {
        Row: {
          category_id: string | null
          id: string
          product_id: string | null
          promotion_id: string
          role: string
          variant_id: string | null
        }
        Insert: {
          category_id?: string | null
          id?: string
          product_id?: string | null
          promotion_id: string
          role?: string
          variant_id?: string | null
        }
        Update: {
          category_id?: string | null
          id?: string
          product_id?: string | null
          promotion_id?: string
          role?: string
          variant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "promotion_targets_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotion_targets_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_listing"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotion_targets_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotion_targets_promotion_id_fkey"
            columns: ["promotion_id"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotion_targets_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      promotions: {
        Row: {
          apply_scope: string
          code: string | null
          created_at: string
          ends_at: string | null
          get_scope: string
          id: string
          is_active: boolean
          name: string
          params: Json
          per_customer_limit: number
          priority: number
          revision: number
          stackable: boolean
          starts_at: string | null
          type: string
          updated_at: string
          usage_limit: number | null
          used_count: number
        }
        Insert: {
          apply_scope?: string
          code?: string | null
          created_at?: string
          ends_at?: string | null
          get_scope?: string
          id?: string
          is_active?: boolean
          name: string
          params?: Json
          per_customer_limit?: number
          priority?: number
          revision?: number
          stackable?: boolean
          starts_at?: string | null
          type: string
          updated_at?: string
          usage_limit?: number | null
          used_count?: number
        }
        Update: {
          apply_scope?: string
          code?: string | null
          created_at?: string
          ends_at?: string | null
          get_scope?: string
          id?: string
          is_active?: boolean
          name?: string
          params?: Json
          per_customer_limit?: number
          priority?: number
          revision?: number
          stackable?: boolean
          starts_at?: string | null
          type?: string
          updated_at?: string
          usage_limit?: number | null
          used_count?: number
        }
        Relationships: []
      }
      shipping_methods: {
        Row: {
          countries: string[]
          created_at: string
          description: string
          estimated_days: string
          free_above: number | null
          id: string
          is_active: boolean
          name: string
          position: number
          price: number
          revision: number
          updated_at: string
        }
        Insert: {
          countries?: string[]
          created_at?: string
          description?: string
          estimated_days?: string
          free_above?: number | null
          id?: string
          is_active?: boolean
          name: string
          position?: number
          price?: number
          revision?: number
          updated_at?: string
        }
        Update: {
          countries?: string[]
          created_at?: string
          description?: string
          estimated_days?: string
          free_above?: number | null
          id?: string
          is_active?: boolean
          name?: string
          position?: number
          price?: number
          revision?: number
          updated_at?: string
        }
        Relationships: []
      }
      tax_rates: {
        Row: {
          country: string
          created_at: string
          id: string
          include_shipping: boolean
          is_active: boolean
          name: string
          rate: number
          revision: number
        }
        Insert: {
          country?: string
          created_at?: string
          id?: string
          include_shipping?: boolean
          is_active?: boolean
          name: string
          rate: number
          revision?: number
        }
        Update: {
          country?: string
          created_at?: string
          id?: string
          include_shipping?: boolean
          is_active?: boolean
          name?: string
          rate?: number
          revision?: number
        }
        Relationships: []
      }
      variant_option_values: {
        Row: {
          option_value_id: string
          variant_id: string
        }
        Insert: {
          option_value_id: string
          variant_id: string
        }
        Update: {
          option_value_id?: string
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "variant_option_values_option_value_id_fkey"
            columns: ["option_value_id"]
            isOneToOne: false
            referencedRelation: "product_option_values"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "variant_option_values_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      product_listing: {
        Row: {
          categories: string[] | null
          compare_at_from: number | null
          created_at: string | null
          currency: string | null
          description: string | null
          id: string | null
          in_stock: boolean | null
          name: string | null
          price_from: number | null
          primary_image: string | null
          product_type: string | null
          slug: string | null
          tags: string[] | null
          vendor: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      abandon_cart: {
        Args: {
          cart_id: string
          expected_version: number
          guest_token?: string
        }
        Returns: Json
      }
      adjust_inventory: {
        Args: {
          delta: number
          idempotency_key: string
          location_id?: string
          note?: string
          reason?: string
          variant_id: string
        }
        Returns: {
          location_id: string
          on_hand: number
          reservation_revision: number
          variant_id: string
        }
        SetofOptions: {
          from: "*"
          to: "inventory_levels"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      anonymize_customer: {
        Args: { customer_id: string }
        Returns: {
          anonymized_at: string | null
          auth_user_id: string | null
          created_at: string
          email: string | null
          full_name: string
          id: string
          phone: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "customers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      anonymize_user: {
        Args: { p_user_id: string }
        Returns: {
          created_at: string
          email: string
          id: string
          role: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "profiles"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      assert_metaobject_exists: { Args: { p_ref: string }; Returns: undefined }
      bind_payment_intent_provider: {
        Args: {
          amount: number
          currency: string
          payment_intent_id: string
          provider_reference: string
          provider_status: string
        }
        Returns: Json
      }
      bind_refund_request_provider: {
        Args: {
          amount: number
          currency: string
          provider_reference: string
          provider_status: string
          refund_request_id: string
        }
        Returns: Json
      }
      cancel_checkout_quote: {
        Args: { quote_id: string; reason?: string }
        Returns: Json
      }
      cancel_order: {
        Args: { order_id: string; reason?: string }
        Returns: Json
      }
      cancel_refund_request: {
        Args: {
          actor_id: string
          provider_confirmed?: boolean
          reason?: string
          refund_request_id: string
        }
        Returns: Json
      }
      cancel_zero_value_order_item: {
        Args: {
          idempotency_key: string
          order_id: string
          order_item_id: string
          quantity: number
          reason?: string
        }
        Returns: Json
      }
      capture_payment_intent: {
        Args: {
          idempotency_key: string
          payment_intent_id: string
          provider_reference: string
        }
        Returns: Json
      }
      checkout_cart: {
        Args: { cart_id: string; expected_version: number }
        Returns: Json
      }
      claim_cart: {
        Args: { cart_id: string; expected_version: number; guest_token: string }
        Returns: Json
      }
      claim_outbox_events: {
        Args: { lease_seconds?: number; max_events?: number; worker_id: string }
        Returns: Json
      }
      close_return: {
        Args: { cancel?: boolean; return_id: string }
        Returns: Json
      }
      complete_outbox_event: {
        Args: {
          error_message?: string
          event_id: string
          lease_token: string
          succeeded: boolean
          worker_id: string
        }
        Returns: boolean
      }
      create_cart: {
        Args: { idempotency_key?: string; ttl_seconds?: number }
        Returns: Json
      }
      create_category: {
        Args: { category_id: string; changes: Json }
        Returns: Json
      }
      create_checkout_quote: {
        Args: {
          address?: Json
          address_id?: string
          discount_code?: string
          idempotency_key: string
          items: Json
          note?: string
          shipping_method_id?: string
          ttl_seconds?: number
        }
        Returns: Json
      }
      create_customer: {
        Args: {
          email?: string
          full_name?: string
          idempotency_key: string
          phone?: string
        }
        Returns: {
          anonymized_at: string | null
          auth_user_id: string | null
          created_at: string
          email: string | null
          full_name: string
          id: string
          phone: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "customers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_customer_address: {
        Args: { address_id: string; changes: Json; customer_id: string }
        Returns: Json
      }
      create_fulfillment: {
        Args: {
          carrier?: string
          idempotency_key: string
          items: Json
          order_id: string
          tracking_number?: string
          tracking_url?: string
        }
        Returns: Json
      }
      create_location: {
        Args: { changes: Json; location_id: string }
        Returns: Json
      }
      create_metafield: {
        Args: { changes: Json; metafield_id: string }
        Returns: Json
      }
      create_metafield_definition: {
        Args: { changes: Json; definition_id: string }
        Returns: Json
      }
      create_metaobject: {
        Args: { changes: Json; metaobject_id: string }
        Returns: Json
      }
      create_metaobject_definition: {
        Args: { changes: Json; definition_id: string }
        Returns: Json
      }
      create_order: {
        Args: {
          address?: Json
          address_id?: string
          discount_code?: string
          idempotency_key: string
          items: Json
          note?: string
          shipping_method_id?: string
        }
        Returns: Json
      }
      create_order_from_quote: { Args: { quote_id: string }; Returns: Json }
      create_payment_intent: {
        Args: {
          idempotency_key: string
          metadata?: Json
          order_id: string
          payment_method?: string
          provider: string
        }
        Returns: Json
      }
      create_payment_intent_for_customer: {
        Args: {
          actor_id: string
          idempotency_key: string
          metadata?: Json
          order_id: string
          payment_method?: string
          provider: string
        }
        Returns: Json
      }
      create_product: {
        Args: { changes: Json; product_id: string }
        Returns: Json
      }
      create_promotion: {
        Args: { changes: Json; promotion_id: string }
        Returns: Json
      }
      create_refund_request: {
        Args: {
          actor_id: string
          amount?: number
          idempotency_key: string
          items?: Json
          metadata?: Json
          order_id: string
          provider: string
          reason?: string
          restock?: boolean
          shipping_amount?: number
        }
        Returns: Json
      }
      create_return: {
        Args: {
          fulfillment_id: string
          idempotency_key: string
          items: Json
          reason?: string
        }
        Returns: Json
      }
      create_shipping_method: {
        Args: { changes: Json; shipping_method_id: string }
        Returns: Json
      }
      create_tax_rate: {
        Args: { changes: Json; tax_rate_id: string }
        Returns: Json
      }
      current_customer_id: { Args: never; Returns: string }
      delete_customer_address: {
        Args: {
          address_id: string
          customer_id: string
          expected_updated_at: string
        }
        Returns: Json
      }
      delete_metafield: {
        Args: { expected_revision: number; metafield_id: string }
        Returns: Json
      }
      delete_metaobject: {
        Args: { expected_revision: number; metaobject_id: string }
        Returns: Json
      }
      delete_metaobject_definition: {
        Args: { definition_id: string; expected_revision: number }
        Returns: Json
      }
      delete_review: {
        Args: { expected_revision: number; review_id: string }
        Returns: Json
      }
      dispose_return_receipt: {
        Args: {
          disposition: string
          idempotency_key: string
          note?: string
          quantity: number
          receipt_line_id: string
        }
        Returns: Json
      }
      expire_checkout_quotes: {
        Args: { as_of?: string; max_quotes?: number }
        Returns: Json
      }
      export_admin_orders: {
        Args: {
          after_id?: string
          end_at: string
          page_size?: number
          start_at: string
        }
        Returns: Json
      }
      get_admin_category: { Args: { category_id: string }; Returns: Json }
      get_admin_checkout_quote: { Args: { quote_id: string }; Returns: Json }
      get_admin_customer: { Args: { customer_id: string }; Returns: Json }
      get_admin_location: { Args: { location_id: string }; Returns: Json }
      get_admin_metafield_definition: {
        Args: { definition_id: string }
        Returns: Json
      }
      get_admin_metaobject: { Args: { metaobject_id: string }; Returns: Json }
      get_admin_metaobject_definition: {
        Args: { definition_id: string }
        Returns: Json
      }
      get_admin_operations_summary: {
        Args: { component: string; end_at: string; start_at: string }
        Returns: Json
      }
      get_admin_order: { Args: { order_id: string }; Returns: Json }
      get_admin_order_summary: {
        Args: { end_at: string; start_at: string }
        Returns: Json
      }
      get_admin_payment_summary: {
        Args: { end_at: string; start_at: string }
        Returns: Json
      }
      get_admin_product: { Args: { product_id: string }; Returns: Json }
      get_admin_promotion: { Args: { promotion_id: string }; Returns: Json }
      get_admin_review: { Args: { review_id: string }; Returns: Json }
      get_admin_shipping_method: {
        Args: { shipping_method_id: string }
        Returns: Json
      }
      get_admin_shop_settings: { Args: never; Returns: Json }
      get_admin_tax_rate: { Args: { tax_rate_id: string }; Returns: Json }
      get_admin_user: { Args: { user_id: string }; Returns: Json }
      get_cart: {
        Args: { cart_id: string; guest_token?: string }
        Returns: Json
      }
      get_checkout_quote: { Args: { quote_id: string }; Returns: Json }
      get_customer_order: { Args: { order_id: string }; Returns: Json }
      get_inventory_availability: {
        Args: { location_id?: string; variant_id: string }
        Returns: Json
      }
      get_inventory_transfer: { Args: { transfer_id: string }; Returns: Json }
      get_order_checkout_quote: { Args: { order_id: string }; Returns: Json }
      get_order_fulfillment_balance: {
        Args: { order_id: string }
        Returns: Json
      }
      get_order_ledger: { Args: { order_id: string }; Returns: Json }
      get_order_pricing: { Args: { order_id: string }; Returns: Json }
      get_order_returns: { Args: { order_id: string }; Returns: Json }
      get_payment_intent_for_customer: {
        Args: { actor_id: string; payment_intent_id: string; provider: string }
        Returns: Json
      }
      get_payment_operations: { Args: { order_id: string }; Returns: Json }
      get_storefront_product: { Args: { product_id: string }; Returns: Json }
      ingest_payment_provider_event: {
        Args: {
          data: Json
          event_type: string
          livemode: boolean
          object_reference: string
          occurred_at: string
          payload_hash: string
          provider: string
          provider_event_id: string
          source: string
        }
        Returns: Json
      }
      is_admin: { Args: never; Returns: boolean }
      list_admin_categories: {
        Args: {
          active?: boolean
          after_id?: string
          page_size?: number
          parent_id?: string
          root_only?: boolean
          search?: string
        }
        Returns: Json
      }
      list_admin_checkout_quotes: {
        Args: {
          after_id?: string
          customer_id_filter?: string
          has_order?: boolean
          page_size?: number
          status_filter?: string
        }
        Returns: Json
      }
      list_admin_customers: {
        Args: {
          after_cursor?: Json
          anonymized?: boolean
          page_size?: number
          search?: string
        }
        Returns: Json
      }
      list_admin_discount_redemptions: {
        Args: {
          after_id?: string
          customer_id?: string
          order_id?: string
          page_size?: number
          promotion_id: string
        }
        Returns: Json
      }
      list_admin_inventory_movements: {
        Args: {
          after_id?: string
          location_id?: string
          order_id?: string
          page_size?: number
          reason_filter?: string
          variant_id?: string
        }
        Returns: Json
      }
      list_admin_locations: {
        Args: {
          active?: boolean
          after_id?: string
          page_size?: number
          search?: string
        }
        Returns: Json
      }
      list_admin_metafield_definitions: {
        Args: {
          access_filter?: string
          after_id?: string
          namespace_filter?: string
          owner_type_filter?: string
          page_size?: number
        }
        Returns: Json
      }
      list_admin_metafields: {
        Args: {
          after_id?: string
          key_filter?: string
          namespace_filter?: string
          owner_id_filter: string
          owner_type_filter: string
          page_size?: number
        }
        Returns: Json
      }
      list_admin_metaobject_definitions: {
        Args: {
          access_filter?: string
          active?: boolean
          after_id?: string
          page_size?: number
          type_filter?: string
        }
        Returns: Json
      }
      list_admin_metaobjects: {
        Args: {
          after_id?: string
          definition_id_filter: string
          handle_filter?: string
          page_size?: number
          status_filter?: string
        }
        Returns: Json
      }
      list_admin_order_events: {
        Args: {
          after_id?: string
          order_id: string
          page_size?: number
          type_filter?: string
        }
        Returns: Json
      }
      list_admin_orders: {
        Args: {
          after_order_number?: string
          customer_id?: string
          financial_status_filter?: string
          fulfillment_status_filter?: string
          page_size?: number
          status_filter?: string
        }
        Returns: Json
      }
      list_admin_outbox_events: {
        Args: {
          after_id?: string
          aggregate_id?: string
          page_size?: number
          status_filter?: string
        }
        Returns: Json
      }
      list_admin_payment_operations: {
        Args: {
          after_id?: string
          kind: string
          order_id: string
          page_size?: number
        }
        Returns: Json
      }
      list_admin_payment_provider_events: {
        Args: {
          after_cursor?: Json
          page_size?: number
          resource_id?: string
          status_filter?: string
        }
        Returns: Json
      }
      list_admin_products: {
        Args: {
          after_cursor?: Json
          category_id?: string
          page_size?: number
          search?: string
          status_filter?: string
        }
        Returns: Json
      }
      list_admin_promotion_targets: {
        Args: {
          after_id?: string
          page_size?: number
          promotion_id: string
          role_filter?: string
        }
        Returns: Json
      }
      list_admin_promotions: {
        Args: {
          active?: boolean
          after_id?: string
          code_only?: boolean
          page_size?: number
          search?: string
          type_filter?: string
        }
        Returns: Json
      }
      list_admin_reconciliation_issues: {
        Args: {
          after_cursor?: Json
          page_size?: number
          status_filter?: string
        }
        Returns: Json
      }
      list_admin_reviews: {
        Args: {
          after_id?: string
          customer_id_filter?: string
          page_size?: number
          product_id_filter?: string
          rating_filter?: number
          status_filter?: string
        }
        Returns: Json
      }
      list_admin_shipping_methods: {
        Args: {
          active?: boolean
          after_id?: string
          country?: string
          page_size?: number
          search?: string
        }
        Returns: Json
      }
      list_admin_tax_rates: {
        Args: {
          active?: boolean
          after_id?: string
          country?: string
          page_size?: number
          search?: string
        }
        Returns: Json
      }
      list_admin_users: {
        Args: {
          after_id?: string
          page_size?: number
          role_filter?: string
          search?: string
        }
        Returns: Json
      }
      list_carts: { Args: never; Returns: Json }
      list_customer_orders: {
        Args: {
          after_order_number?: string
          financial_status_filter?: string
          fulfillment_status_filter?: string
          page_size?: number
          status_filter?: string
        }
        Returns: Json
      }
      list_pending_paypal_captures: {
        Args: { max_requests?: number }
        Returns: Json
      }
      list_pending_provider_refunds: {
        Args: { max_requests?: number; provider: string }
        Returns: Json
      }
      list_storefront_products: {
        Args: { after_id?: string; category_id?: string; page_size?: number }
        Returns: Json
      }
      mark_order_paid: {
        Args: {
          idempotency_key: string
          order_id: string
          provider?: string
          provider_ref?: string
        }
        Returns: Json
      }
      moderate_review: {
        Args: { expected_revision?: number; review_id: string; status: string }
        Returns: {
          body: string
          created_at: string
          customer_id: string
          id: string
          product_id: string
          rating: number
          revision: number
          status: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "product_reviews"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      prepare_paypal_capture: {
        Args: { actor_id: string; payment_intent_id: string }
        Returns: Json
      }
      prepare_paypal_refund: {
        Args: { actor_id: string; refund_request_id: string }
        Returns: Json
      }
      preview_cart: {
        Args: { cart_id: string; guest_token?: string }
        Returns: Json
      }
      price_checkout: {
        Args: {
          address?: Json
          discount_code?: string
          items: Json
          shipping_method_id?: string
        }
        Returns: Json
      }
      purge_expired_carts: {
        Args: { as_of?: string; max_carts?: number }
        Returns: number
      }
      receive_return: {
        Args: {
          idempotency_key: string
          items: Json
          location_id: string
          note?: string
          return_id: string
        }
        Returns: Json
      }
      redrive_outbox_event: {
        Args: {
          event_id: string
          expected_attempt: number
          reason?: string
          worker_id?: string
        }
        Returns: boolean
      }
      refund_order: {
        Args: {
          amount?: number
          idempotency_key: string
          items?: Json
          order_id: string
          provider?: string
          reason?: string
          restock?: boolean
          shipping_amount?: number
        }
        Returns: Json
      }
      retry_payment_provider_events: {
        Args: { max_events?: number }
        Returns: Json
      }
      set_default_address: {
        Args: { address_id: string; make_default?: boolean }
        Returns: {
          city: string | null
          country: string
          created_at: string
          customer_id: string
          id: string
          is_default: boolean
          label: string
          line1: string
          line2: string | null
          phone: string | null
          postal_code: string | null
          recipient_name: string
          region: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "addresses"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_default_location: {
        Args: {
          expected_default_id?: string
          expected_revision: number
          location_id: string
        }
        Returns: Json
      }
      set_user_role: {
        Args: { role: string; user_id: string }
        Returns: {
          created_at: string
          email: string
          id: string
          role: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "profiles"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      transfer_inventory: {
        Args: {
          from_location_id: string
          idempotency_key: string
          note?: string
          quantity: number
          to_location_id: string
          variant_id: string
        }
        Returns: Json
      }
      update_cart: {
        Args: {
          address?: Json
          cart_id: string
          discount_code?: string
          expected_version: number
          guest_token?: string
          items: Json
          note?: string
          shipping_method_id?: string
        }
        Returns: Json
      }
      update_category: {
        Args: {
          category_id: string
          changes: Json
          expected_updated_at: string
        }
        Returns: Json
      }
      update_customer: {
        Args: {
          changes: Json
          customer_id: string
          expected_updated_at: string
        }
        Returns: Json
      }
      update_customer_address: {
        Args: {
          address_id: string
          changes: Json
          customer_id: string
          expected_updated_at: string
        }
        Returns: Json
      }
      update_fulfillment: {
        Args: {
          changes: Json
          expected_version: number
          fulfillment_id: string
          idempotency_key: string
        }
        Returns: Json
      }
      update_location: {
        Args: { changes: Json; expected_revision: number; location_id: string }
        Returns: Json
      }
      update_metafield: {
        Args: { changes: Json; expected_revision: number; metafield_id: string }
        Returns: Json
      }
      update_metafield_definition: {
        Args: {
          changes: Json
          definition_id: string
          expected_revision: number
        }
        Returns: Json
      }
      update_metaobject: {
        Args: {
          changes: Json
          expected_revision: number
          metaobject_id: string
        }
        Returns: Json
      }
      update_metaobject_definition: {
        Args: {
          changes: Json
          definition_id: string
          expected_revision: number
        }
        Returns: Json
      }
      update_order_address: {
        Args: { address?: Json; address_id?: string; order_id: string }
        Returns: Json
      }
      update_order_admin_note: {
        Args: { changes: Json; order_id: string }
        Returns: Json
      }
      update_product: {
        Args: { changes: Json; expected_revision: number; product_id: string }
        Returns: Json
      }
      update_promotion: {
        Args: { changes: Json; expected_revision: number; promotion_id: string }
        Returns: Json
      }
      update_shipping_method: {
        Args: {
          changes: Json
          expected_revision: number
          shipping_method_id: string
        }
        Returns: Json
      }
      update_shop_settings: {
        Args: { changes: Json; expected_revision: number }
        Returns: Json
      }
      update_tax_rate: {
        Args: { changes: Json; expected_revision: number; tax_rate_id: string }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

