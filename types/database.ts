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
          city: string
          country: string
          created_at: string
          customer_id: string
          detail: string
          id: string
          is_default: boolean
          label: string
          phone: string
          postal_code: string | null
          province: string
          receiver: string
          updated_at: string
        }
        Insert: {
          city?: string
          country?: string
          created_at?: string
          customer_id?: string
          detail: string
          id?: string
          is_default?: boolean
          label?: string
          phone: string
          postal_code?: string | null
          province?: string
          receiver: string
          updated_at?: string
        }
        Update: {
          city?: string
          country?: string
          created_at?: string
          customer_id?: string
          detail?: string
          id?: string
          is_default?: boolean
          label?: string
          phone?: string
          postal_code?: string | null
          province?: string
          receiver?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "addresses_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
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
            referencedRelation: "profiles"
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
          variant_id: string
        }
        Insert: {
          location_id: string
          on_hand?: number
          variant_id: string
        }
        Update: {
          location_id?: string
          on_hand?: number
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
        }
        Insert: {
          address?: Json | null
          code: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name: string
        }
        Update: {
          address?: Json | null
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name?: string
        }
        Relationships: []
      }
      metafield_definitions: {
        Row: {
          created_at: string
          description: string
          id: string
          key: string
          name: string
          namespace: string
          owner_type: string
          position: number
          type: string
          updated_at: string
          validations: Json
        }
        Insert: {
          created_at?: string
          description?: string
          id?: string
          key: string
          name: string
          namespace?: string
          owner_type: string
          position?: number
          type: string
          updated_at?: string
          validations?: Json
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          key?: string
          name?: string
          namespace?: string
          owner_type?: string
          position?: number
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
          owner_id: string
          owner_type: string
          type: string
          updated_at: string
          value: Json
        }
        Insert: {
          created_at?: string
          id?: string
          key: string
          namespace?: string
          owner_id: string
          owner_type: string
          type: string
          updated_at?: string
          value: Json
        }
        Update: {
          created_at?: string
          id?: string
          key?: string
          namespace?: string
          owner_id?: string
          owner_type?: string
          type?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      metaobject_definitions: {
        Row: {
          created_at: string
          description: string
          fields: Json
          id: string
          is_active: boolean
          name: string
          type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string
          fields: Json
          id?: string
          is_active?: boolean
          name: string
          type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string
          fields?: Json
          id?: string
          is_active?: boolean
          name?: string
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
          status: string
          updated_at: string
          values: Json
        }
        Insert: {
          created_at?: string
          definition_id: string
          handle: string
          id?: string
          status?: string
          updated_at?: string
          values?: Json
        }
        Update: {
          created_at?: string
          definition_id?: string
          handle?: string
          id?: string
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
          discount_total: number
          id: string
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
          discount_total?: number
          id?: string
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
          discount_total?: number
          id?: string
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
        }
        Insert: {
          amount: number
          code?: string | null
          created_at?: string
          name: string
          order_id: string
          promotion_id: string
        }
        Update: {
          amount?: number
          code?: string | null
          created_at?: string
          name?: string
          order_id?: string
          promotion_id?: string
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
          shipping_address: Json
          shipping_method_id: string | null
          shipping_method_name: string | null
          shipping_total: number
          status: string
          subtotal: number
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
          shipping_address: Json
          shipping_method_id?: string | null
          shipping_method_name?: string | null
          shipping_total?: number
          status?: string
          subtotal: number
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
          shipping_address?: Json
          shipping_method_id?: string | null
          shipping_method_name?: string | null
          shipping_total?: number
          status?: string
          subtotal?: number
          tax_total?: number
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
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
      payments: {
        Row: {
          amount: number
          created_at: string
          currency: string
          id: string
          kind: string
          order_id: string
          provider: string
          provider_ref: string | null
          raw: Json | null
          status: string
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          currency?: string
          id?: string
          kind?: string
          order_id: string
          provider?: string
          provider_ref?: string | null
          raw?: Json | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          id?: string
          kind?: string
          order_id?: string
          provider?: string
          provider_ref?: string | null
          raw?: Json | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
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
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_reviews_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
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
          full_name: string
          id: string
          phone: string | null
          role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string
          full_name?: string
          id: string
          phone?: string | null
          role?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          phone?: string | null
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
          code: string | null
          created_at: string
          ends_at: string | null
          id: string
          is_active: boolean
          name: string
          params: Json
          per_customer_limit: number
          priority: number
          stackable: boolean
          starts_at: string | null
          type: string
          updated_at: string
          usage_limit: number | null
          used_count: number
        }
        Insert: {
          code?: string | null
          created_at?: string
          ends_at?: string | null
          id?: string
          is_active?: boolean
          name: string
          params?: Json
          per_customer_limit?: number
          priority?: number
          stackable?: boolean
          starts_at?: string | null
          type: string
          updated_at?: string
          usage_limit?: number | null
          used_count?: number
        }
        Update: {
          code?: string | null
          created_at?: string
          ends_at?: string | null
          id?: string
          is_active?: boolean
          name?: string
          params?: Json
          per_customer_limit?: number
          priority?: number
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
        }
        Insert: {
          country?: string
          created_at?: string
          id?: string
          include_shipping?: boolean
          is_active?: boolean
          name: string
          rate: number
        }
        Update: {
          country?: string
          created_at?: string
          id?: string
          include_shipping?: boolean
          is_active?: boolean
          name?: string
          rate?: number
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
        Insert: {
          categories?: never
          compare_at_from?: never
          created_at?: string | null
          description?: string | null
          id?: string | null
          in_stock?: never
          name?: string | null
          price_from?: never
          primary_image?: never
          product_type?: string | null
          slug?: string | null
          tags?: string[] | null
          vendor?: string | null
        }
        Update: {
          categories?: never
          compare_at_from?: never
          created_at?: string | null
          description?: string | null
          id?: string | null
          in_stock?: never
          name?: string | null
          price_from?: never
          primary_image?: never
          product_type?: string | null
          slug?: string | null
          tags?: string[] | null
          vendor?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _line_in_scope: {
        Args: {
          p_category_ids: string[]
          p_product_id: string
          p_promotion_id: string
          p_role: string
          p_variant_id: string
        }
        Returns: boolean
      }
      adjust_inventory: {
        Args: {
          delta: number
          location_id?: string
          note?: string
          reason?: string
          variant_id: string
        }
        Returns: {
          location_id: string
          on_hand: number
          variant_id: string
        }
        SetofOptions: {
          from: "*"
          to: "inventory_levels"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      anonymize_user: {
        Args: { p_user_id: string }
        Returns: {
          created_at: string
          email: string
          full_name: string
          id: string
          phone: string | null
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
      cancel_order: {
        Args: { order_id: string; reason?: string }
        Returns: {
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
          shipping_address: Json
          shipping_method_id: string | null
          shipping_method_name: string | null
          shipping_total: number
          status: string
          subtotal: number
          tax_total: number
          total: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_fulfillment: {
        Args: {
          carrier?: string
          items: Json
          order_id: string
          tracking_number?: string
          tracking_url?: string
        }
        Returns: {
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
        }
        SetofOptions: {
          from: "*"
          to: "fulfillments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_order: {
        Args: {
          address?: Json
          address_id?: string
          discount_code?: string
          items: Json
          note?: string
          shipping_method_id?: string
        }
        Returns: {
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
          shipping_address: Json
          shipping_method_id: string | null
          shipping_method_name: string | null
          shipping_total: number
          status: string
          subtotal: number
          tax_total: number
          total: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      is_admin: { Args: never; Returns: boolean }
      mark_order_paid: {
        Args: { order_id: string; provider?: string; provider_ref?: string }
        Returns: {
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
          shipping_address: Json
          shipping_method_id: string | null
          shipping_method_name: string | null
          shipping_total: number
          status: string
          subtotal: number
          tax_total: number
          total: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      moderate_review: {
        Args: { review_id: string; status: string }
        Returns: {
          body: string
          created_at: string
          customer_id: string
          id: string
          product_id: string
          rating: number
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
      price_checkout: {
        Args: {
          address?: Json
          discount_code?: string
          items: Json
          shipping_method_id?: string
        }
        Returns: Json
      }
      refund_order: {
        Args: {
          amount?: number
          items?: Json
          order_id: string
          provider?: string
          reason?: string
          restock?: boolean
        }
        Returns: {
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
          shipping_address: Json
          shipping_method_id: string | null
          shipping_method_name: string | null
          shipping_total: number
          status: string
          subtotal: number
          tax_total: number
          total: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_user_role: {
        Args: { role: string; user_id: string }
        Returns: {
          created_at: string
          email: string
          full_name: string
          id: string
          phone: string | null
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
      update_order_address: {
        Args: { address?: Json; address_id?: string; order_id: string }
        Returns: {
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
          shipping_address: Json
          shipping_method_id: string | null
          shipping_method_name: string | null
          shipping_total: number
          status: string
          subtotal: number
          tax_total: number
          total: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "orders"
          isOneToOne: true
          isSetofReturn: false
        }
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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

